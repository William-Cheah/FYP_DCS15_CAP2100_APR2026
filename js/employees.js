/**
 * employees.js — Employee Management CRUD
 *
 * Create, read, update, and deactivate employee records in Firestore.
 *
 * Fields managed: name, id (emp ID), email, role, department, employment_status
 * Safety fields (score, violations, badges) are managed by the AI engine — not editable here.
 *
 * Reference: ISO 45001:2018 Clause 7.1 — the organisation shall determine and
 * provide the resources needed for OH&S, which includes maintaining accurate
 * worker records.
 */

import { db } from './firebase-config.js';
import { getAuth, onAuthStateChanged }
    from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import {
    collection, onSnapshot, doc, addDoc, updateDoc, query, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

const auth = getAuth();

let allEmployees = [];
let editingDocId = null;  // null = adding new, string = editing existing

const tbody    = document.getElementById('emp-tbody');
const searchEl = document.getElementById('emp-search');

searchEl.addEventListener('input', renderTable);

// ── Boot ──────────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
    if (!user) { window.location.href = 'login.html'; return; }
    loadEmployees();
});

function loadEmployees() {
    onSnapshot(collection(db, 'users'), snap => {
        allEmployees = [];
        snap.forEach(d => {
            const data = d.data();
            allEmployees.push({
                docId:      d.id,
                empId:      data.id        || '',
                name:       data.name      || '',
                email:      data.email     || '',
                role:       data.role      || 'Employee',
                department: data.department || '',
                empStatus:  data.employment_status || 'Active',
                score:      data.current_score ?? 100,
            });
        });
        allEmployees.sort((a, b) => a.name.localeCompare(b.name));
        renderTable();
    }, err => {
        console.error('Employee load error:', err);
        tbody.innerHTML = `<tr><td colspan="7" style="color:#ef4444; text-align:center; padding:20px;">
            Failed to load employees. Check Firebase permissions.</td></tr>`;
    });
}

function renderTable() {
    const search = searchEl.value.toLowerCase().trim();
    const filtered = allEmployees.filter(e =>
        e.name.toLowerCase().includes(search) ||
        e.empId.toLowerCase().includes(search)
    );

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#94a3b8; padding:30px;">
            ${allEmployees.length === 0 ? 'No employees registered yet.' : 'No match found.'}</td></tr>`;
        return;
    }

    tbody.innerHTML = '';
    filtered.forEach((e, i) => {
        const statusColor = e.empStatus === 'Active'   ? '#10b981'
                          : e.empStatus === 'Resigned' ? '#64748b' : '#ef4444';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="color:#475569; font-size:0.8em;">${i + 1}</td>
            <td style="font-weight:600; color:#e2e8f0;">${esc(e.name)}</td>
            <td style="color:#94a3b8; font-family:monospace;">${esc(e.empId)}</td>
            <td style="color:#94a3b8; font-size:0.85em;">${esc(e.email) || '—'}</td>
            <td>
                <span style="background:rgba(59,130,246,0.15); color:#60a5fa;
                             padding:2px 9px; border-radius:10px; font-size:0.78em;">
                    ${esc(e.role)}
                </span>
            </td>
            <td>
                <span style="color:${statusColor}; font-size:0.85em; font-weight:600;">
                    ${esc(e.empStatus)}
                </span>
            </td>
            <td>
                <button class="tbl-btn archive" onclick="openEditModal('${e.docId}')">Edit</button>
                <button class="tbl-btn warning" onclick="openDeactivate('${e.docId}', '${esc(e.name)}')">
                    Deactivate
                </button>
            </td>`;
        tbody.appendChild(tr);
    });
}

// ── Add / Edit Modal ──────────────────────────────────────────────────────────
window.openAddModal = function() {
    editingDocId = null;
    document.getElementById('modal-heading').textContent = 'Add Employee';
    document.getElementById('f-name').value     = '';
    document.getElementById('f-id').value       = '';
    document.getElementById('f-email').value    = '';
    document.getElementById('f-role').value     = 'Employee';
    document.getElementById('f-dept').value     = '';
    document.getElementById('f-empstatus').value = 'Active';
    document.getElementById('f-id').disabled   = false;
    hideError();
    document.getElementById('emp-modal').style.display = 'flex';
};

window.openEditModal = function(docId) {
    editingDocId = docId;
    const emp = allEmployees.find(e => e.docId === docId);
    if (!emp) return;
    document.getElementById('modal-heading').textContent = `Edit — ${emp.name}`;
    document.getElementById('f-name').value     = emp.name;
    document.getElementById('f-id').value       = emp.empId;
    document.getElementById('f-email').value    = emp.email;
    document.getElementById('f-role').value     = emp.role;
    document.getElementById('f-dept').value     = emp.department;
    document.getElementById('f-empstatus').value = emp.empStatus;
    document.getElementById('f-id').disabled   = true;  // ID immutable after creation
    hideError();
    document.getElementById('emp-modal').style.display = 'flex';
};

window.closeEmpModal = function() {
    document.getElementById('emp-modal').style.display = 'none';
    editingDocId = null;
};

window.saveEmployee = async function() {
    const name     = document.getElementById('f-name').value.trim();
    const empId    = document.getElementById('f-id').value.trim();
    const email    = document.getElementById('f-email').value.trim();
    const role     = document.getElementById('f-role').value;
    const dept     = document.getElementById('f-dept').value.trim();
    const empStatus = document.getElementById('f-empstatus').value;

    if (!name || !empId || !email) {
        showError('Name, Employee ID and Email are required.'); return;
    }

    const btn = document.getElementById('modal-save-btn');
    btn.textContent = 'Saving...'; btn.disabled = true;

    try {
        if (editingDocId) {
            // Update existing.
            // Keep the safety `status` field in sync with `employment_status`:
            //   Suspended → status: 'Suspended'  (blocks login via login.js)
            //   Active    → status: 'Active'      (restores access)
            // Note: "Resigned" is removed from the Edit dropdown — use the
            //   Deactivate button instead, which correctly sets status: 'Inactive',
            //   clears gold_badge, and shows the PDPA confirmation dialog.
            const statusSync = empStatus === 'Suspended' ? { status: 'Suspended' }
                             : empStatus === 'Active'    ? { status: 'Active' }
                             : {};
            await updateDoc(doc(db, 'users', editingDocId), {
                name, email, role, department: dept, employment_status: empStatus,
                ...statusSync,
            });
        } else {
            // Check for duplicate ID
            const dup = await getDocs(query(collection(db, 'users'), where('id', '==', empId)));
            if (!dup.empty) {
                showError(`Employee ID "${empId}" is already in use.`);
                btn.textContent = 'Save'; btn.disabled = false;
                return;
            }
            // Add new document
            await addDoc(collection(db, 'users'), {
                id: empId, name, email, role,
                department: dept,
                employment_status: empStatus,
                current_score: 100,
                status: 'Active',
                gold_badge: false,
                safe_worker_status: 'Standard',
                reward_points: 0,
                is_repeat_offender: false,
            });
        }
        closeEmpModal();
    } catch (err) {
        console.error('Save error:', err);
        showError('Save failed. Check console for details.');
        btn.textContent = 'Save'; btn.disabled = false;
    }
};

// ── Deactivate (soft delete) ──────────────────────────────────────────────────
window.openDeactivate = function(docId, name) {
    document.getElementById('del-msg').textContent =
        `This will set ${name}'s employment status to "Resigned" and freeze AI monitoring. ` +
        `Historical violation records are preserved per PDPA 2010 and ISO 45001:2018 Clause 7.5.3.`;
    document.getElementById('del-confirm-btn').onclick = () => deactivate(docId, name);
    document.getElementById('del-modal').style.display = 'flex';
};

async function deactivate(docId, name) {
    try {
        await updateDoc(doc(db, 'users', docId), {
            employment_status: 'Resigned',
            status: 'Inactive',
            gold_badge: false,
        });
        document.getElementById('del-modal').style.display = 'none';
        alert(`${name} has been deactivated. Records preserved.`);
    } catch (err) {
        console.error('Deactivate error:', err);
        alert('Failed to deactivate. Check console.');
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showError(msg) {
    const el = document.getElementById('modal-error');
    el.textContent = msg;
    el.style.display = 'block';
}
function hideError() {
    document.getElementById('modal-error').style.display = 'none';
}
function esc(str) {
    return String(str ?? '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
