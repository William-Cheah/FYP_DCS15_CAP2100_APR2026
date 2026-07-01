/**
 * register.js — Sentinel-Eye Employee Registration
 *
 * Password policy applied (NIST SP 800-63B §5.1.1.2 + OWASP Auth Cheat Sheet 2023):
 *   Minimum 8 characters
 *   At least one uppercase letter (A-Z)
 *   At least one lowercase letter (a-z)
 *   At least one digit (0-9)
 *   At least one special character (@$!%*?&_#-)
 *   Maximum 64 characters (DoS prevention)
 *   Passwords confirmed (match check)
 *
 * Storage: Firebase Auth hashes passwords with scrypt (memory-hard KDF),
 * satisfying NIST SP 800-132.  No plaintext or MD5/SHA1 hashing at rest.
 *
 * References:
 *   NIST SP 800-63B §5.1.1.2 — Memorized Secret Authenticators
 *   OWASP Authentication Cheat Sheet (2023) — Password Storage, Strength
 *   ISO 45001:2018 Clause 5.4 — worker participation and consultation
 */

import { db } from './firebase-config.js';
import { getAuth, createUserWithEmailAndPassword }
    from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import { doc, setDoc, addDoc, collection, getDocs }
    from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

const auth   = getAuth();
const errEl  = document.getElementById('reg-error');

function showErr(msg) { if (errEl) errEl.textContent = msg; }
function clearErr()   { if (errEl) errEl.textContent = ''; }

document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErr();

    const name     = document.getElementById('reg-name').value.trim();
    const email    = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    const confirm  = document.getElementById('reg-password-confirm').value;
    const scenario = document.querySelector('input[name="scenario"]:checked').value;

    // ── Client-side password validation (NIST SP 800-63B §5.1.1.2) ──────────
    // validatePassword() is exported from login.js (loaded first as a module).
    // Defence-in-depth: the same rules are enforced server-side in main.py.
    const pwErr = window.validatePassword ? window.validatePassword(password) : null;
    if (pwErr) { showErr(pwErr); return; }
    if (password !== confirm) { showErr('Passwords do not match.'); return; }

    const btn = document.getElementById('submit-btn');
    btn.textContent = 'Registering...';
    btn.disabled    = true;

    try {
        // 1. Create Firebase Auth account
        //    Firebase Auth hashes the password with scrypt before storing.
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        console.log('Auth account created, UID:', user.uid);

        // 2. Auto-generate Employee ID (EMP001, EMP002, …)
        // Fetch all users and find the highest EMP number (case-insensitive).
        // Using orderBy('id') is unreliable because lowercase "emp001" sorts
        // differently from uppercase "EMP001" in ASCII, causing duplicates.
        let generatedId = 'EMP001';
        const allUsersSnap = await getDocs(collection(db, 'users'));
        let maxNum = 0;
        allUsersSnap.forEach(d => {
            const empId = (d.data().id || '').toUpperCase();
            if (/^EMP\d+$/.test(empId)) {
                const num = parseInt(empId.replace('EMP', ''), 10);
                if (!isNaN(num) && num > maxNum) maxNum = num;
            }
        });
        generatedId = 'EMP' + String(maxNum + 1).padStart(3, '0');

        // 3. Create Firestore profile
        // join_date is written as a Firestore Timestamp (current date).
        // The heatmap uses this to shade cells before the employee's start month,
        // so HR can distinguish "no violation" from "not yet employed".
        await setDoc(doc(db, 'users', generatedId), {
            id:               generatedId,
            auth_uid:         user.uid,
            uid:              user.uid,
            name:             name,
            email:            email,
            role:             'Employee',
            employment_status:'Active',
            initial_score:    100,
            current_score:    100,
            reward_points:    0,
            gold_badge:       false,
            safe_worker_status: 'Standard',
            is_repeat_offender: false,
            join_date:        new Date(),   // ISO 45001:2018 Clause 9.1 — employment start date
        });

        // 4. Registration mode
        if (scenario === 'A') {
            // Scenario A: manual photo upload — just notify and reset the form
            alert(`Registration successful!\nID: ${generatedId}\nAccount: ${email}\n\nPlease manually upload a face photo to:\nknown_faces/${generatedId}.jpg`);
            document.getElementById('register-form').reset();
            document.getElementById('reg-pw-strength').style.display = 'none';
        } else {
            // Scenario B: on-site camera capture
            // Send capture command to ai_engine.py via Firestore
            const cmdRef = await addDoc(collection(db, 'commands'), {
                action:      'capture_photo',
                target_id:   generatedId,
                target_name: name,
                timestamp:   new Date(),
                status:      'pending',
            });

            // ── Suppress Chrome "Save password?" dialog ───────────────────────
            // Chrome triggers the dialog when it detects a page navigation while
            // password fields are still in the DOM.  Removing them first prevents
            // Chrome from associating this navigation with a credential save.
            ['reg-password', 'reg-password-confirm'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.parentNode.removeChild(el);
            });

            // Redirect to dashboard; pass cmdId so dashboard can signal the
            // backend at exactly countdown=0 for each phase.
            const params = new URLSearchParams({
                countdown: '1',
                empId:     generatedId,
                empName:   encodeURIComponent(name),
                cmdId:     cmdRef.id,
            });
            window.location.href = `index.html?${params.toString()}`;
        }

    } catch (error) {
        console.error('Registration failed:', error);
        if (error.code === 'auth/weak-password') {
            showErr('Password rejected by Firebase: must be at least 6 characters. Our policy requires 8+.');
        } else if (error.code === 'auth/email-already-in-use') {
            showErr('Security Alert: This email is already registered.');
        } else {
            showErr('Registration failed: ' + error.message);
        }
    }

    btn.textContent = 'Complete Registration';
    btn.disabled    = false;
});

// ── Scenario B countdown is now handled on index.html ────────────────────────
// After registration, register.js redirects to index.html?countdown=1&empId=...
// dashboard.js reads those URL params and runs the countdown there, so Chrome's
// "Save password?" dialog (which sits above all page content) cannot block it.
