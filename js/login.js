/**
 * login.js — Sentinel-Eye Login with MFA & Forgot Password
 *
 * Authentication flow (MFA):
 *   Step 1 — Email + password Firebase Auth verification
 *   Step 2 — 6-digit OTP sent to registered email user enters code redirect
 *            (requires Flask backend on localhost:5050)
 *            If backend is OFFLINE, MFA step is skipped and login proceeds
 *            without OTP (graceful degradation for development / backend-down scenarios).
 *
 * Forgot Password flow:
 *   Always uses Firebase's built-in sendPasswordResetEmail() — sends a secure
 *   reset link directly to the user's email.  No Flask backend required.
 *   (Reference: Firebase Auth — server-managed password reset tokens)
 *
 *   Optional enhanced flow (when Flask backend is online):
 *   Email 6-digit OTP (5-min TTL) OTP verify new password via Admin SDK
 *
 * Password policy (NIST SP 800-63B §5.1.1.2 + OWASP Auth Cheat Sheet 2023):
 *   Minimum 8 chars · Uppercase · Lowercase · Digit · Special char · Max 64 chars
 *
 * Password storage:
 *   Firebase Auth hashes passwords with scrypt (memory-hard KDF),
 *   satisfying NIST SP 800-132 — no plaintext storage at any point.
 */

import { db } from './firebase-config.js';
import {
    getAuth, signInWithEmailAndPassword, signOut,
    sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import { collection, query, where, getDocs, updateDoc }
    from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

const FLASK_API        = 'http://localhost:5050';
const FLASK_TIMEOUT_MS = 4000;    // ping / reachability check only
const FLASK_OP_TIMEOUT = 15000;   // OTP send/verify/reset — SMTP can take several seconds

// TOTP helpers (Web Crypto API — RFC 6238 / RFC 4226)
// No external library needed. Works in any modern browser.

function _base32ToBytes(base32) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const c of base32.toUpperCase().replace(/=+$/, '')) {
        const idx = chars.indexOf(c);
        if (idx >= 0) bits += idx.toString(2).padStart(5, '0');
    }
    const bytes = new Uint8Array(Math.floor(bits.length / 8));
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    }
    return bytes;
}

async function _hotp(secretBytes, counter) {
    const buf = new ArrayBuffer(8);
    const dv  = new DataView(buf);
    dv.setUint32(0, Math.floor(counter / 0x100000000), false);
    dv.setUint32(4, counter >>> 0, false);
    const key  = await crypto.subtle.importKey('raw', secretBytes,
        { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sig  = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
    const off  = sig[sig.length - 1] & 0x0f;
    const code = (((sig[off] & 0x7f) << 24) | ((sig[off+1] & 0xff) << 16) |
                  ((sig[off+2] & 0xff) << 8) | (sig[off+3] & 0xff)) % 1_000_000;
    return code.toString().padStart(6, '0');
}

async function _verifyTotp(base32Secret, token, windowSize = 1) {
    const secretBytes = _base32ToBytes(base32Secret);
    const step = Math.floor(Date.now() / 1000 / 30);
    for (let i = -windowSize; i <= windowSize; i++) {
        if (await _hotp(secretBytes, step + i) === token) return true;
    }
    return false;
}

const auth  = getAuth();
const errEl = document.getElementById('error-message');

function showError(msg) { if (errEl) errEl.textContent = msg; }
function clearError()   { if (errEl) errEl.textContent = ''; }

function setBtn(id, text, disabled) {
    const btn = document.getElementById(id);
    if (btn) { btn.textContent = text; btn.disabled = disabled; }
}

// Module-level state kept between Step 1 and Step 2
let _pendingEmail      = '';
let _pendingIsAdmin    = false;
let _pendingAuthUser   = null;
let _pendingTotpSecret = null;   // set if the user has TOTP configured

// ── Backend reachability check ────────────────────────────────────────────────
async function isBackendOnline() {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FLASK_TIMEOUT_MS);
        const res = await fetch(`${FLASK_API}/api/send_otp`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ email: '__ping__', purpose: 'mfa' }),
            signal:  ctrl.signal,
        });
        clearTimeout(timer);
        // Any HTTP response (even 400) means the server is up
        return true;
    } catch {
        return false;
    }
}

// Attempt to POST to a Flask endpoint; returns null on network failure or timeout.
// Uses FLASK_OP_TIMEOUT (15 s) so that SMTP email delivery has time to complete
// before we give up and fall back to the offline path.
async function flaskPost(path, body) {
    try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FLASK_OP_TIMEOUT);
        const res   = await fetch(`${FLASK_API}${path}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
            signal:  ctrl.signal,
        });
        clearTimeout(timer);
        return await res.json();
    } catch {
        return null;   // null = network failure / timeout
    }
}

// ── Redirect after auth ───────────────────────────────────────────────────────
function redirectAfterLogin() {
    window.location.href = _pendingIsAdmin ? 'index.html' : 'employee.html';
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 1 — Email + Password
// ══════════════════════════════════════════════════════════════════════════════
const loginForm = document.getElementById('login-form');
if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearError();
        setBtn('login-btn', 'Verifying...', true);

        const email    = document.getElementById('login-email').value.trim();
        const password = document.getElementById('login-password').value;

        try {
            // 1a. Firebase Auth — verify email + password
            const credential = await signInWithEmailAndPassword(auth, email, password);
            _pendingAuthUser = credential.user;
            _pendingEmail    = email.toLowerCase();

            // 1b. Firestore — find user document + determine role
            const q    = query(collection(db, 'users'), where('email', '==', email));
            const snap = await getDocs(q);

            if (snap.empty) {
                await signOut(auth);
                showError('Security Alert: User profile not found in the database.');
                setBtn('login-btn', 'Access Console', false);
                return;
            }

            // ── Account status check (OWASP Access Control) ──────────────────
            // Block login for:
            //   • employment_status = 'Resigned' / 'Inactive'  (HR deactivation)
            //   • status = 'Suspended'  (safety score hit 0, or admin suspension)
            let accountBlocked    = false;
            let accountSuspended  = false;
            snap.forEach(d => {
                const data      = d.data();
                const empStatus  = (data.employment_status || '').toLowerCase();
                const safeStatus = (data.status || '').toLowerCase();
                if (empStatus === 'resigned' || empStatus === 'inactive') {
                    accountBlocked = true;
                }
                // Suspended can be set by two paths:
                //   • status = 'Suspended'  (rules engine / database_manager.py auto-suspend at score 0)
                //   • employment_status = 'Suspended'  (admin manually suspends via Employee Management page)
                if (safeStatus === 'suspended' || empStatus === 'suspended') {
                    accountSuspended = true;
                }
                if (!accountBlocked && !accountSuspended) {
                    if (data.role === 'admin' || data.role === 'Admin') _pendingIsAdmin = true;
                    _pendingTotpSecret = data.totp_secret || null;
                    // Auto-link UID on first login
                    if (data.uid !== _pendingAuthUser.uid) {
                        updateDoc(d.ref, { uid: _pendingAuthUser.uid }).catch(console.warn);
                    }
                }
            });

            if (accountBlocked) {
                await signOut(auth);
                showError('Your account has been deactivated. Please contact your administrator.');
                setBtn('login-btn', 'Access Console', false);
                return;
            }

            if (accountSuspended) {
                await signOut(auth);
                showError('Your account is suspended due to safety violations. Please contact your administrator.');
                setBtn('login-btn', 'Access Console', false);
                return;
            }

            // 1c. Choose MFA method:
            //   Priority 1 — Google Authenticator TOTP (if user has set it up)
            //   Priority 2 — Email OTP via Flask backend (if backend online)
            //   Fallback    — No MFA (backend offline, TOTP not configured)
            if (_pendingTotpSecret) {
                // User has TOTP configured show Google Authenticator step
                // Reference: RFC 6238, NIST SP 800-63B §5.1.4
                document.getElementById('login-form').style.display   = 'none';
                document.getElementById('forgot-link').style.display  = 'none';
                document.getElementById('auth-subtitle').textContent  =
                    'Enter the 6-digit code from Google Authenticator';
                document.getElementById('otp-step').style.display     = 'block';
                document.getElementById('otp-step-label').textContent =
                    'Google Authenticator (TOTP)';
                document.getElementById('otp-info-box').innerHTML =
                    `<strong style="color:#38bdf8;">Google Authenticator Required</strong><br>
                     Open your authenticator app and enter the current 6-digit code.<br>
                     <span style="display:block; margin-top:6px; color:#64748b; font-size:0.9em;">
                     (RFC 6238 TOTP · NIST SP 800-63B §5.1.4)</span>`;
                document.getElementById('resend-otp').style.display = 'none';
                document.getElementById('otp-input').focus();

            } else {
                // Try email OTP via Flask backend
                const otpRes = await flaskPost('/api/send_otp', {
                    email:   _pendingEmail,
                    purpose: 'mfa',
                });

                if (otpRes && otpRes.status === 'success') {
                    // Backend is online — show email OTP step
                    document.getElementById('login-form').style.display   = 'none';
                    document.getElementById('forgot-link').style.display  = 'none';
                    document.getElementById('auth-subtitle').textContent  =
                        `A verification code was sent to ${_pendingEmail}`;
                    document.getElementById('otp-step').style.display     = 'block';
                    document.getElementById('otp-input').focus();
                } else {
                    // Graceful degradation — no MFA configured, backend offline
                    console.warn('MFA backend unavailable — proceeding without OTP step.');
                    redirectAfterLogin();
                }
            }

        } catch (err) {
            console.error('Login Step 1 error:', err);
            const msg =
                err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password'
                    ? 'Incorrect email or password.'
                : err.code === 'auth/too-many-requests'
                    ? 'Too many failed attempts. Please wait before trying again.'
                : (err.message || 'Login failed.');
            showError(msg);
            setBtn('login-btn', 'Access Console', false);
        }
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 2 — OTP Verification (MFA)
// ══════════════════════════════════════════════════════════════════════════════
const otpForm = document.getElementById('otp-form');
if (otpForm) {
    otpForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearError();
        setBtn('otp-btn', 'Verifying...', true);

        const code = document.getElementById('otp-input').value.trim();

        if (_pendingTotpSecret) {
            // ── TOTP verification (Google Authenticator) ──────────────────
            // Reference: RFC 6238, NIST SP 800-63B §5.1.4
            // Uses Web Crypto API — no external library required
            try {
                const valid = await _verifyTotp(_pendingTotpSecret, code, 1); // ±30 s clock skew
                if (valid) {
                    redirectAfterLogin();
                } else {
                    showError('Incorrect code. Make sure your phone clock is accurate.');
                    setBtn('otp-btn', 'Verify Code', false);
                }
            } catch (err) {
                console.error('TOTP verify error:', err);
                showError('Verification error. Please try again.');
                setBtn('otp-btn', 'Verify Code', false);
            }

        } else {
            // ── Email OTP verification (Flask backend) ────────────────────
            const res = await flaskPost('/api/verify_otp', {
                email:   _pendingEmail,
                code,
                purpose: 'mfa',
            });
            if (res && res.status === 'success') {
                redirectAfterLogin();
            } else {
                showError((res && res.message) || 'Invalid or expired code. Please try again.');
                setBtn('otp-btn', 'Verify Code', false);
            }
        }
    });
}

// Resend OTP
const resendBtn = document.getElementById('resend-otp');
if (resendBtn) {
    resendBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        clearError();
        resendBtn.textContent = 'Sending...';
        const res = await flaskPost('/api/send_otp', { email: _pendingEmail, purpose: 'mfa' });
        if (res && res.status === 'success') {
            document.getElementById('otp-input').value = '';
            document.getElementById('otp-input').focus();
            resendBtn.textContent = 'Sent!';
            setTimeout(() => { resendBtn.textContent = 'Resend code'; }, 3000);
        } else {
            resendBtn.textContent = 'Resend code';
            showError('Could not resend code. Make sure the backend is running.');
        }
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// Forgot Password Modal
// ══════════════════════════════════════════════════════════════════════════════
// Primary method: Firebase sendPasswordResetEmail() — always works, no backend needed.
//   Firebase generates a time-limited, single-use token and emails a secure reset link.
//   (Reference: Firebase Auth documentation — password reset flow)
//
// Enhanced method (when Flask backend is online): 6-digit OTP with 5-min expiry.
//   If the backend is reachable, the enhanced flow is shown instead.
//   (Reference: NIST SP 800-63B §5.1.1, OWASP Forgot Password Cheat Sheet 2023)
// ══════════════════════════════════════════════════════════════════════════════

const forgotLink = document.getElementById('forgot-link');
if (forgotLink) {
    forgotLink.addEventListener('click', (e) => { e.preventDefault(); openForgotModal(); });
}

window.openForgotModal = function() {
    document.getElementById('forgot-modal').style.display = 'flex';
    document.getElementById('reset-step-email').style.display = 'block';
    document.getElementById('reset-step-code').style.display  = 'none';
    document.getElementById('reset-step-firebase').style.display = 'none';
    document.getElementById('reset-email').value = '';
    document.getElementById('reset-error').textContent = '';
};

window.closeForgotModal = function() {
    document.getElementById('forgot-modal').style.display = 'none';
};

window.sendResetOtp = async function() {
    const email = (document.getElementById('reset-email').value || '').trim().toLowerCase();
    const errEl = document.getElementById('reset-error');
    errEl.textContent = '';

    if (!email) { errEl.textContent = 'Please enter your email.'; return; }

    const btn = document.getElementById('reset-send-btn');
    btn.textContent = 'Sending code…';
    btn.disabled    = true;

    // Try Flask backend first (enhanced OTP flow).
    // Uses FLASK_OP_TIMEOUT (15 s) to allow SMTP delivery time to complete.
    const res = await flaskPost('/api/send_otp', { email, purpose: 'reset' });

    if (res && res.status === 'success') {
        // Backend online — show 6-digit OTP step
        document.getElementById('reset-step-email').style.display    = 'none';
        document.getElementById('reset-step-code').style.display     = 'block';
        document.getElementById('reset-step-firebase').style.display = 'none';
        document.getElementById('reset-otp').focus();
    } else {
        // Backend offline — fall back to Firebase built-in reset link
        try {
            await sendPasswordResetEmail(auth, email);
            document.getElementById('reset-step-email').style.display    = 'none';
            document.getElementById('reset-step-code').style.display     = 'none';
            document.getElementById('reset-step-firebase').style.display = 'block';
        } catch (fbErr) {
            // Firebase also failed (e.g. email not found) — show generic message
            // (don't reveal whether email exists — OWASP Forgot Password Cheat Sheet)
            console.warn('Firebase reset error:', fbErr);
            document.getElementById('reset-step-email').style.display    = 'none';
            document.getElementById('reset-step-code').style.display     = 'none';
            document.getElementById('reset-step-firebase').style.display = 'block';
        }
    }

    btn.textContent = 'Send Reset Link';
    btn.disabled    = false;
};

window.confirmPasswordReset = async function() {
    const email   = (document.getElementById('reset-email').value || '').trim().toLowerCase();
    const code    = (document.getElementById('reset-otp').value || '').trim();
    const newPw   = document.getElementById('reset-new-password').value;
    const confirm = document.getElementById('reset-confirm-password').value;
    const errEl   = document.getElementById('reset-error');
    errEl.textContent = '';

    const pwErr = window.validatePassword ? window.validatePassword(newPw) : null;
    if (pwErr) { errEl.textContent = pwErr; return; }
    if (newPw !== confirm) { errEl.textContent = 'Passwords do not match.'; return; }

    const btn = document.querySelector('#reset-step-code button[onclick="confirmPasswordReset()"]');
    if (btn) { btn.textContent = 'Resetting...'; btn.disabled = true; }

    const res = await flaskPost('/api/reset_password', {
        email,
        code,
        new_password: newPw,
    });

    if (res && res.status === 'success') {
        closeForgotModal();
        alert('Password reset successfully. Please log in with your new password.');
    } else {
        errEl.textContent = (res && res.message) || 'Reset failed. Please try again.';
    }

    if (btn) { btn.textContent = 'Reset Password'; btn.disabled = false; }
};

// ══════════════════════════════════════════════════════════════════════════════
// Password Strength + Validation Helpers
// Exported to window so register.js can reuse them.
//
// Reference: NIST SP 800-63B §5.1.1.2 — Memorized Secret Authenticators
//            OWASP Authentication Cheat Sheet (2023)
// ══════════════════════════════════════════════════════════════════════════════
window.validatePassword = function(pw) {
    if (!pw || pw.length < 8)      return 'Password must be at least 8 characters.';
    if (pw.length > 64)             return 'Password must be 64 characters or fewer.';
    if (!/[A-Z]/.test(pw))          return 'Password must include at least one uppercase letter (A-Z).';
    if (!/[a-z]/.test(pw))          return 'Password must include at least one lowercase letter (a-z).';
    if (!/\d/.test(pw))             return 'Password must include at least one number (0-9).';
    if (!/[@$!%*?&_#\-]/.test(pw)) return 'Password must include at least one special character (@$!%*?&_#-).';
    return null;
};

window.checkPwStrength = function(inputId, boxId) {
    const pw  = document.getElementById(inputId).value;
    const box = document.getElementById(boxId);
    if (!pw) { box.style.display = 'none'; return; }
    box.style.display = 'block';

    const checks = [
        { label: 'At least 8 characters',         pass: pw.length >= 8 },
        { label: 'Max 64 characters',              pass: pw.length <= 64 },
        { label: 'Uppercase letter (A-Z)',          pass: /[A-Z]/.test(pw) },
        { label: 'Lowercase letter (a-z)',          pass: /[a-z]/.test(pw) },
        { label: 'Number (0-9)',                    pass: /\d/.test(pw) },
        { label: 'Special char (@$!%*?&_#-)',       pass: /[@$!%*?&_#\-]/.test(pw) },
    ];

    const passed = checks.filter(c => c.pass).length;
    const pct    = Math.round((passed / checks.length) * 100);
    const color  = passed <= 2 ? '#ef4444' : passed <= 4 ? '#f59e0b' : '#10b981';
    const label  = passed <= 2 ? 'Weak' : passed <= 4 ? 'Fair' : passed === checks.length ? 'Strong ' : 'Good';

    box.innerHTML = `
        <div style="display:flex; justify-content:space-between; margin-bottom:5px;">
            <span style="font-size:0.75em; color:${color}; font-weight:bold;">${label}</span>
            <span style="font-size:0.7em; color:#64748b;">NIST SP 800-63B §5.1.1.2</span>
        </div>
        <div style="background:#0f172a; border-radius:4px; height:5px; margin-bottom:8px; overflow:hidden;">
            <div style="width:${pct}%; height:100%; background:${color}; border-radius:4px; transition:width 0.3s;"></div>
        </div>
        ${checks.map(c => `
            <div style="font-size:0.73em; margin:2px 0; color:${c.pass ? '#10b981' : '#64748b'};">
                ${c.pass ? '' : ''} ${c.label}
            </div>`).join('')}`;
};

window.togglePwVisibility = function(inputId, btn) {
    const inp = document.getElementById(inputId);
    if (inp.type === 'password') { inp.type = 'text'; btn.textContent = '\u{1F441}'; }
    else                         { inp.type = 'password'; btn.textContent = '\u{1F441}'; }
};

// ── Live password requirements checklist (reset password modal) ───────────────
// Each rule changes from grey (not met) to green (met) as the user types.
// Reference: NIST SP 800-63B §5.1.1.2 + OWASP Authentication Cheat Sheet (2023)
window.updatePwChecklist = function(pw) {
    const rules = [
        { id: 'chk-upper',   pass: /[A-Z]/.test(pw),          label: 'At least one uppercase letter (A-Z)' ,   fail: 'At least one uppercase letter (A-Z)' },
        { id: 'chk-lower',   pass: /[a-z]/.test(pw),          label: 'At least one lowercase letter (a-z)',    fail: 'At least one lowercase letter (a-z)' },
        { id: 'chk-digit',   pass: /\d/.test(pw),             label: 'At least one number (0-9)',              fail: 'At least one number (0-9)' },
        { id: 'chk-special', pass: /[@$!%*?&_#\-]/.test(pw), label: 'At least one special character (@$!%*?&_#-)', fail: 'At least one special character (@$!%*?&_#-)' },
        { id: 'chk-length',  pass: pw.length >= 8,            label: 'At least 8 characters',                 fail: 'At least 8 characters' },
    ];
    rules.forEach(r => {
        const el = document.getElementById(r.id);
        if (!el) return;
        el.textContent = r.pass ? r.label : r.fail;
        el.style.color  = r.pass ? '#10b981' : '#64748b';   // green when passed, grey when not
    });
};
