/**
 * sidebar.js — Injects the sidebar and highlights the active page.
 *
 * All admin pages import this module. It builds the nav in JS so there is
 * a single source of truth for the menu (no need to edit every HTML file
 * when adding a new page).
 */

import { getAuth, signOut }
    from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";

// NOTE: getAuth() is NOT called here at module load time.
// sidebar.js loads before the page-specific JS on some pages (e.g. report.html),
// meaning Firebase hasn't been initialized yet. Calling getAuth() lazily inside
// the logout handler is safe because by then the page JS has run initializeApp().
const sidebarContainer = document.getElementById('sidebar-container');

// ── Inject sidebar HTML ───────────────────────────────────────────────────────
sidebarContainer.innerHTML = `
    <div class="sidebar">
        <div class="sidebar-header">
            <h2>Sentinel-Eye</h2>
            <div class="subtitle">SECURITY CONSOLE</div>
        </div>

        <ul class="nav-links">
            <li><a href="index.html"      id="nav-dashboard">Dashboard</a></li>
            <li><a href="roster.html"     id="nav-roster">Safety Roster</a></li>
            <li><a href="violations.html" id="nav-violations">Violation Records</a></li>
            <li><a href="unknown.html"    id="nav-unknown">Unknown Faces</a></li>
            <li><a href="employees.html"  id="nav-employees">Employee Management</a></li>
            <li><a href="report.html"     id="nav-report">Analytics &amp; Reports</a></li>
            <li><a href="register.html"   id="nav-register">Register Account</a></li>
        </ul>

        <div class="sidebar-footer">
            <button id="logout-btn" class="logout-btn">Logout</button>
        </div>
    </div>
`;

// ── Highlight active page ─────────────────────────────────────────────────────
const path = window.location.pathname;
const navMap = {
    'index.html':      'nav-dashboard',
    'roster.html':     'nav-roster',
    'violations.html': 'nav-violations',
    'unknown.html':    'nav-unknown',
    'employees.html':  'nav-employees',
    'report.html':     'nav-report',
    'register.html':   'nav-register',
};
Object.entries(navMap).forEach(([page, id]) => {
    if (path.includes(page)) {
        document.getElementById(id)?.classList.add('active');
    }
});

// ── Logout ────────────────────────────────────────────────────────────────────
// getAuth() is called here lazily — by the time the button is clicked,
// Firebase has always been initialized by the page-specific JS.
document.getElementById('logout-btn').addEventListener('click', async () => {
    try {
        await signOut(getAuth());
    } catch (e) {
        console.warn('Sign-out error:', e);
    }
    window.location.href = 'login.html';
});
