/**
 * violations.js — Dedicated Violation Records page
 *
 * Features:
 *   • Filter by employee, type, date range, sort order
 *   • Paginated at PAGE_SIZE rows
 *   • Photo lightbox on thumbnail click
 *   • Dispute button: marks a detection as wrong, restores employee marks
 *
 * Dispute / Revert logic:
 *   When an admin disputes a detection (wrong/false positive):
 *     1. Detection document gets disputed:true + reason stored in Firestore
 *     2. Employee safety score restored: +15 pts (capped at 100)
 *     3. Employee reward points restored: +5 pts
 *   Disputed records remain visible with a strikethrough badge for audit trail.
 *   Reference: ISO 45001:2018 Clause 9.1 — accurate incident records;
 *              ISO 45001:2018 Clause 10.2 — incident investigation & correction.
 */

import { db } from './firebase-config.js';
import { getAuth, onAuthStateChanged }
    from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import {
    collection, onSnapshot, query, orderBy,
    doc, updateDoc, getDocs, where, getDoc
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

const auth        = getAuth();
const tbody       = document.getElementById('viol-tbody');
const countEl     = document.getElementById('viol-count');
const loadMoreBtn = document.getElementById('load-more-btn');

const PAGE_SIZE = 30;
let allViolations = [];
let shownCount    = 0;
let disputeTarget = null;   // { docId, empId, empName, violation, tsStr }

// ── Filters ───────────────────────────────────────────────────────────────────
const searchEl = document.getElementById('viol-search');
const typeEl   = document.getElementById('viol-type');
const dateEl   = document.getElementById('viol-date');
const sortEl   = document.getElementById('viol-sort');

[searchEl, typeEl, dateEl, sortEl].forEach(el => el.addEventListener('change', applyAndRender));
searchEl.addEventListener('input', applyAndRender);

// ── Boot ──────────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
    if (!user) { window.location.href = 'login.html'; return; }
    initViolations();
});

function initViolations() {
    const q = query(collection(db, 'detections'), orderBy('timestamp', 'desc'));
    onSnapshot(q, snapshot => {
        allViolations = [];
        snapshot.forEach(d => {
            const data = d.data();
            let tsMs = 0, tsStr = 'Unknown Time';
            if (data.timestamp && typeof data.timestamp.toDate === 'function') {
                const dt = data.timestamp.toDate();
                tsMs  = dt.getTime();
                tsStr = dt.toLocaleString();
            }
            allViolations.push({
                docId:      d.id,                         // Firestore document ID
                empId:      data.id       || 'Unknown',
                name:       data.name     || 'Unknown',
                violation:  data.violation || 'Unknown',
                image_url:  data.image_url || '',
                confidence: data.confidence_score ?? null,
                disputed:   data.disputed === true,
                disputed_reason: data.disputed_reason || '',
                tsMs,
                tsStr,
            });
        });
        applyAndRender();
    }, err => {
        console.error('Violations load error:', err);
        tbody.innerHTML = `<tr><td colspan="7" style="color:#ef4444; text-align:center; padding:20px;">
            Failed to load violation records. Check Firebase permissions.</td></tr>`;
    });
}

function applyAndRender() {
    const search  = searchEl.value.toLowerCase();
    const typeVal = typeEl.value;
    const dateVal = dateEl.value;
    const sortVal = sortEl.value;
    const cutoff  = dateVal === 'all' ? 0 : Date.now() - parseInt(dateVal) * 86400000;

    let filtered = allViolations.filter(v => {
        if (typeVal !== 'all' && v.violation !== typeVal) return false;
        if (v.tsMs > 0 && v.tsMs < cutoff)               return false;
        const term = search.trim();
        if (term && !v.name.toLowerCase().includes(term) &&
                    !v.empId.toLowerCase().includes(term)) return false;
        return true;
    });

    if (sortVal === 'oldest') filtered.reverse();

    countEl.textContent = `${filtered.length} record${filtered.length !== 1 ? 's' : ''} found`;
    shownCount = Math.min(PAGE_SIZE, filtered.length);
    renderRows(filtered.slice(0, shownCount));
    loadMoreBtn.style.display = filtered.length > PAGE_SIZE ? 'inline-block' : 'none';

    loadMoreBtn.onclick = () => {
        shownCount = Math.min(shownCount + PAGE_SIZE, filtered.length);
        renderRows(filtered.slice(0, shownCount));
        if (shownCount >= filtered.length) loadMoreBtn.style.display = 'none';
    };
}

function renderRows(rows) {
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#94a3b8; padding:30px;">
            No violations match the current filter.</td></tr>`;
        return;
    }

    tbody.innerHTML = '';
    rows.forEach((v, i) => {
        const typeColor = v.violation === 'No Helmet' ? '#ef4444'
                        : v.violation === 'No Vest'   ? '#f59e0b' : '#94a3b8';
        const typeIcon  = v.violation === 'No Helmet' ? ''
                        : v.violation === 'No Vest'   ? ''  : '';

        const confHtml = v.confidence !== null
            ? `<span style="background:rgba(59,130,246,0.15); color:#60a5fa;
                            padding:2px 9px; border-radius:10px; font-size:0.8em;">
                ${v.confidence.toFixed(1)}%</span>`
            : `<span style="color:#475569; font-size:0.8em;">—</span>`;

        const photoHtml = v.image_url
            ? `<img src="${v.image_url}"
                    onclick="openLightbox('${v.image_url}', '${escHtml(v.name)} — ${escHtml(v.violation)} — ${escHtml(v.tsStr)}')"
                    style="width:70px; height:52px; object-fit:cover; border-radius:6px;
                           border:1px solid #334155; cursor:pointer; transition:opacity 0.15s;"
                    onmouseover="this.style.opacity='0.75'" onmouseout="this.style.opacity='1'">`
            : `<span style="color:#475569; font-size:0.8em;">No photo</span>`;

        const isUnknown = v.empId === 'Unknown' || v.name === 'Unknown';
        const empHtml   = isUnknown
            ? `<div style="color:#64748b; font-style:italic;">Unknown</div>`
            : `<div style="font-weight:600; color:#e2e8f0;">${escHtml(v.name)}</div>
               <div style="font-size:0.75em; color:#64748b;">${escHtml(v.empId)}</div>`;

        // Dispute button / badge
        const disputeHtml = v.disputed
            ? `<div style="display:inline-block; background:rgba(245,158,11,0.15);
                           color:#f59e0b; font-size:0.72em; font-weight:bold;
                           padding:3px 9px; border-radius:10px; border:1px solid #f59e0b;">
                Reverted
               </div>
               ${v.disputed_reason ? `<div style="font-size:0.7em; color:#64748b; margin-top:3px;
                                          max-width:100px; word-wrap:break-word;">${escHtml(v.disputed_reason)}</div>` : ''}`
            : `<button onclick="openDisputeModal('${escHtml(v.docId)}', '${escHtml(v.empId)}', '${escHtml(v.name)}', '${escHtml(v.violation)}', '${escHtml(v.tsStr)}')"
                       style="padding:4px 10px; background:#334155; color:#f59e0b;
                              border:1px solid #f59e0b; border-radius:6px; cursor:pointer;
                              font-size:0.75em; font-weight:bold; white-space:nowrap;">
                Dispute
               </button>`;

        const tr = document.createElement('tr');
        // Disputed rows get a dimmed / strikethrough style
        if (v.disputed) tr.style.opacity = '0.55';
        tr.innerHTML = `
            <td style="color:#475569; font-size:0.8em;">${i + 1}</td>
            <td style="font-size:0.82em; color:#94a3b8; white-space:nowrap;">
                ${v.disputed ? `<s>${escHtml(v.tsStr)}</s>` : escHtml(v.tsStr)}
            </td>
            <td>${empHtml}</td>
            <td>
                <span style="color:${v.disputed ? '#64748b' : typeColor}; font-weight:600;
                             ${v.disputed ? 'text-decoration:line-through;' : ''}">
                    ${typeIcon} ${escHtml(v.violation)}
                </span>
            </td>
            <td>${confHtml}</td>
            <td>${photoHtml}</td>
            <td>${disputeHtml}</td>`;
        tbody.appendChild(tr);
    });
}

// ── Dispute Modal ─────────────────────────────────────────────────────────────
window.openDisputeModal = function(docId, empId, name, violation, tsStr) {
    disputeTarget = { docId, empId, name, violation, tsStr };

    const isUnknown = empId === 'Unknown' || name === 'Unknown';
    document.getElementById('dispute-emp').textContent   = isUnknown ? 'Unknown (unidentified)' : `${name} (${empId})`;
    document.getElementById('dispute-type').textContent  = violation;
    document.getElementById('dispute-time').textContent  = tsStr;
    document.getElementById('dispute-reason').value      = '';
    document.getElementById('dispute-error').textContent = '';

    // Show/hide the score restoration note based on whether employee is known
    document.getElementById('dispute-restore-note').style.display = isUnknown ? 'none' : 'block';

    document.getElementById('dispute-modal').style.display = 'flex';
};

window.closeDisputeModal = function() {
    document.getElementById('dispute-modal').style.display = 'none';
    disputeTarget = null;
};

window.confirmDispute = async function() {
    if (!disputeTarget) return;
    const reason  = document.getElementById('dispute-reason').value.trim();
    const errEl   = document.getElementById('dispute-error');
    const btn     = document.getElementById('dispute-confirm-btn');
    errEl.textContent = '';
    btn.textContent   = 'Reverting...';
    btn.disabled      = true;

    try {
        const { docId, empId, name } = disputeTarget;
        const isUnknown = empId === 'Unknown' || name === 'Unknown';

        // 1. Mark detection as disputed in Firestore
        //    Reference: ISO 45001:2018 Clause 10.2 — incident investigation & correction
        await updateDoc(doc(db, 'detections', docId), {
            disputed:        true,
            disputed_reason: reason || 'Marked as incorrect by admin',
            disputed_at:     new Date(),
        });

        // 2. Restore employee marks (only if employee is identified)
        //    +15 safety score (capped at 100) — mirrors the deduction in database_manager.py
        //    +5 reward points — mirrors the OWASP-referenced deduction per violation
        //    Reference: ISO 45001:2018 Clause 10.2 — correction of nonconformities
        if (!isUnknown) {
            // Primary lookup: by id field (EMP001, EMP002 …)
            let usersSnap = await getDocs(
                query(collection(db, 'users'), where('id', '==', empId))
            );
            // Fallback: detection may store the known_faces filename instead of EMP ID
            // Try matching by name field so old records still work
            if (usersSnap.empty && name && name !== 'Unknown') {
                usersSnap = await getDocs(
                    query(collection(db, 'users'), where('name', '==', name))
                );
            }
            if (!usersSnap.empty) {
                const userDoc   = usersSnap.docs[0];
                const data      = userDoc.data();
                const oldScore  = data.current_score  ?? 100;
                const oldPts    = data.reward_points   ?? 0;
                // "No Helmet & No Vest" deducts 30 pts (15×2); restore the same amount.
                // All other types deduct 15 pts — restore 15.
                // Reference: mirrors deduction logic in database_manager.py line 199.
                const restorePts = (disputeTarget.violation === 'No Helmet & No Vest') ? 30 : 15;
                const newScore  = Math.min(100, oldScore + restorePts);
                const newPts    = oldPts + 5;

                await updateDoc(userDoc.ref, {
                    current_score:  newScore,
                    reward_points:  newPts,
                    // Re-evaluate status thresholds
                    status: newScore <= 0 ? 'Suspended'
                          : data.status === 'Suspended' && newScore > 0 ? 'Active'
                          : data.status,
                });
                console.log(`[Dispute] Restored: ${name} score ${oldScore}→${newScore} (+${restorePts} pts), reward ${oldPts}→${newPts}`);
            }
        }

        closeDisputeModal();
        alert(`Detection disputed and marks restored${isUnknown ? '' : ` for ${name}`}.`);

    } catch (err) {
        console.error('Dispute error:', err);
        errEl.textContent = 'Failed to dispute record. Check console.';
        btn.textContent   = 'Confirm Dispute';
        btn.disabled      = false;
    }
};

// ── Lightbox ──────────────────────────────────────────────────────────────────
window.openLightbox = function(url, caption) {
    document.getElementById('lightbox-img').src            = url;
    document.getElementById('lightbox-caption').textContent = caption;
    document.getElementById('lightbox').style.display       = 'flex';
};
window.closeLightbox = function() {
    document.getElementById('lightbox').style.display = 'none';
};
document.getElementById('lightbox').addEventListener('click', e => {
    if (e.target === document.getElementById('lightbox')) closeLightbox();
});

function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
