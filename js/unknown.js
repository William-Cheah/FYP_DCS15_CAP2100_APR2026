/**
 * unknown.js — Unknown Faces reassignment page
 *
 * Shows all detections where id == "Unknown".  HR can view the snapshot photo,
 * pick the correct employee from a dropdown, and reassign the record.
 *
 * On reassign:
 *   1. Detection document: id + name updated to the selected employee
 *   2. Employee document:  current_score − 15 (min 0), status updated if needed
 *
 * Reference: ISO 45001:2018 Clause 9.1 — accurate incident attribution is
 * required for meaningful performance monitoring and corrective action.
 */

import { db } from './firebase-config.js';
import { getAuth, onAuthStateChanged }
    from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import {
    collection, onSnapshot, query, where,
    doc, updateDoc, getDocs
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

const auth = getAuth();

let allUnknown  = [];   // {docId, violation, image_url, tsMs, tsStr}
let allEmployees = [];  // {docId, id, name} for the dropdown
let currentRecord = null;  // record being reassigned

const grid     = document.getElementById('unk-grid');
const countEl  = document.getElementById('unk-count');
const typeEl   = document.getElementById('unk-type');
const dateEl   = document.getElementById('unk-date');

[typeEl, dateEl].forEach(el => el.addEventListener('change', renderGrid));

// ── Boot ──────────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
    if (!user) { window.location.href = 'login.html'; return; }
    loadEmployees();
    loadUnknown();
});

function loadEmployees() {
    onSnapshot(collection(db, 'users'), snap => {
        allEmployees = [];
        snap.forEach(d => {
            const data = d.data();
            if (data.id && data.id !== 'Unknown') {
                allEmployees.push({ docId: d.id, empId: data.id, name: data.name || data.id });
            }
        });
        // Refresh dropdown options
        const sel = document.getElementById('reassign-employee');
        const cur = sel.value;
        sel.innerHTML = '<option value="">— Select employee —</option>';
        allEmployees
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(e => {
                sel.innerHTML += `<option value="${e.docId}">${e.name} (${e.empId})</option>`;
            });
        sel.value = cur;
    });
}

function loadUnknown() {
    // Simple query — no orderBy to avoid requiring a composite Firestore index.
    // Sorting is done client-side after the snapshot arrives.
    const q = query(
        collection(db, 'detections'),
        where('id', '==', 'Unknown')
    );
    onSnapshot(q, snap => {
        allUnknown = [];
        snap.forEach(d => {
            const data = d.data();
            let tsMs = 0, tsStr = 'Unknown Time';
            if (data.timestamp?.toDate) {
                const dt = data.timestamp.toDate();
                tsMs  = dt.getTime();
                tsStr = dt.toLocaleString();
            }
            allUnknown.push({
                docId:     d.id,
                violation: data.violation || 'Unknown',
                image_url: data.image_url || '',
                tsMs, tsStr,
            });
        });
        // Sort newest first client-side (avoids composite index requirement)
        allUnknown.sort((a, b) => b.tsMs - a.tsMs);
        renderGrid();
    }, err => {
        console.error('Unknown faces load error:', err);
        grid.innerHTML = `<p style="color:#ef4444; grid-column:1/-1; text-align:center; padding:30px;">
            Failed to load records. Check Firebase permissions.</p>`;
    });
}

function renderGrid() {
    const typeVal = typeEl.value;
    const dateVal = dateEl.value;
    const cutoff  = dateVal === 'all' ? 0 : Date.now() - parseInt(dateVal) * 86400000;

    const filtered = allUnknown.filter(v => {
        if (typeVal !== 'all' && v.violation !== typeVal) return false;
        if (v.tsMs > 0 && v.tsMs < cutoff) return false;
        return true;
    });

    countEl.textContent = `${filtered.length} unidentified record${filtered.length !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
        grid.innerHTML = `<p style="color:#94a3b8; grid-column:1/-1; text-align:center; padding:40px;">
            No unidentified violations for this filter.</p>`;
        return;
    }

    grid.innerHTML = '';
    filtered.forEach(v => {
        const typeColor = v.violation === 'No Helmet' ? '#ef4444'
                        : v.violation === 'No Vest'   ? '#f59e0b' : '#94a3b8';
        const typeIcon  = v.violation === 'No Helmet' ? '' : '';

        const card = document.createElement('div');
        card.style.cssText = 'background:#1e293b; border:1px solid #334155; border-radius:10px; overflow:hidden;';
        card.innerHTML = `
            <div style="position:relative;">
                ${v.image_url
                    ? `<img src="${v.image_url}" style="width:100%; height:150px; object-fit:cover;">`
                    : `<div style="width:100%; height:150px; background:#0f172a; display:flex;
                                  align-items:center; justify-content:center; color:#475569;">No Photo</div>`}
                <span style="position:absolute; top:8px; left:8px; background:rgba(0,0,0,0.7);
                             color:${typeColor}; font-size:0.72em; font-weight:bold;
                             padding:2px 8px; border-radius:8px;">${typeIcon} ${v.violation}</span>
            </div>
            <div style="padding:10px;">
                <div style="font-size:0.75em; color:#64748b; margin-bottom:8px;">${v.tsStr}</div>
                <button onclick="openReassign('${v.docId}')"
                        style="width:100%; padding:7px; background:#3b82f6; color:white;
                               border:none; border-radius:7px; cursor:pointer; font-size:0.82em; font-weight:bold;">
                    Identify &amp; Assign
                </button>
            </div>`;
        grid.appendChild(card);
    });
}

// ── Reassign modal ────────────────────────────────────────────────────────────
// Filter the employee dropdown by the search input
window.filterReassignDropdown = function() {
    const term = document.getElementById('reassign-search').value.toLowerCase();
    const sel  = document.getElementById('reassign-employee');
    const current = sel.value;
    sel.innerHTML = '<option value="">— Select employee —</option>';
    allEmployees
        .filter(e => e.name.toLowerCase().includes(term) || e.empId.toLowerCase().includes(term))
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach(e => {
            sel.innerHTML += `<option value="${e.docId}">${e.name} (${e.empId})</option>`;
        });
    sel.value = current;
};

window.openReassign = function(docId) {
    currentRecord = allUnknown.find(v => v.docId === docId);
    if (!currentRecord) return;

    document.getElementById('reassign-photo').src =
        currentRecord.image_url || '';
    const typeColor = currentRecord.violation === 'No Helmet' ? '#ef4444' : '#f59e0b';
    document.getElementById('reassign-type').innerHTML =
        `<span style="color:${typeColor};">${currentRecord.violation}</span>
         <span style="color:#64748b; font-size:0.8em; margin-left:8px;">${currentRecord.tsStr}</span>`;
    document.getElementById('reassign-search').value = '';
    filterReassignDropdown();   // reset dropdown to full list
    document.getElementById('reassign-employee').value = '';
    document.getElementById('reassign-modal').style.display = 'flex';
};

window.closeReassign = function() {
    document.getElementById('reassign-modal').style.display = 'none';
    currentRecord = null;
};

window.confirmReassign = async function() {
    const sel = document.getElementById('reassign-employee');
    const userDocId = sel.value;
    if (!userDocId) { alert('Please select an employee first.'); return; }
    if (!currentRecord) return;

    const selectedEmp = allEmployees.find(e => e.docId === userDocId);
    if (!selectedEmp) return;

    const btn = document.querySelector('#reassign-modal button[onclick="confirmReassign()"]');
    btn.textContent = 'Saving...';
    btn.disabled = true;

    try {
        // 1. Update the detection record
        await updateDoc(doc(db, 'detections', currentRecord.docId), {
            id:   selectedEmp.empId,
            name: selectedEmp.name,
        });

        // 2. Deduct 15 pts from the employee's safety score
        //    Reference: ISO 45001:2018 Clause 8.2 — proportional consequence
        const userRef = doc(db, 'users', userDocId);
        const userSnap = await getDocs(
            query(collection(db, 'users'), where('id', '==', selectedEmp.empId))
        );
        if (!userSnap.empty) {
            const uDoc = userSnap.docs[0];
            const oldScore = uDoc.data().current_score ?? 100;
            const newScore = Math.max(0, oldScore - 15);
            const newStatus = newScore <= 0 ? 'Suspended'
                            : newScore < 40 ? uDoc.data().status || 'Active'
                            : uDoc.data().status || 'Active';
            await updateDoc(uDoc.ref, {
                current_score: newScore,
                status: newStatus,
                last_violation_date: new Date(),
                gold_badge: false,
                safe_worker_status: 'Standard',
            });
        }

        closeReassign();
        alert(`Violation reassigned to ${selectedEmp.name}. Their score has been updated.`);
    } catch (err) {
        console.error('Reassign error:', err);
        alert('Failed to reassign. Check console for details.');
        btn.textContent = 'Confirm Reassign';
        btn.disabled = false;
    }
};
