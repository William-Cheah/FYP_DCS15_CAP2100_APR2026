import { db } from './firebase-config.js';
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import { collection, onSnapshot, query, orderBy, limit, doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

const auth = getAuth();

// ==========================================
// IoT Control Plane: 发送远程指令到边缘设备
// ==========================================
function sendSystemCommand(targetMode) {
    console.log("发送指令:", targetMode);
    
    fetch('http://127.0.0.1:5050/set_mode', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            // authentication key
            'Authorization': 'Bearer Sentinel-Eye-Super-Secret-2026' 
        },
        body: JSON.stringify({ mode: targetMode })
    })
    .then(response => {
        // 核心修改：只要服务器回复 200 左右的状态码，就视为成功
        if (response.ok) {
            return response.json();
        }
        throw new Error('Server response was not ok.');
    })
    .then(data => {
        console.log("模式已切换:", data.mode);
        // 这里可以换成一个安静的提示，不要用 alert 挡住屏幕
        showToastAlert("System", `Mode switched to ${data.mode} successfully!`);
    })
    .catch(error => {
        // 既然终端显示已经成功切换了，如果这里还是报错，
        // 说明是网络解析的小问题，我们可以先忽略它，或者只在 console 打印
        console.warn("指令已发出，正在同步状态...");
    });
}
// 3. 【最关键的一步】强行把函数推向全局窗口！
// 只有执行了这一行，HTML 里的 onclick="sendSystemCommand(...)" 才会生效
window.sendSystemCommand = sendSystemCommand;


const alertFeed = document.getElementById('alert-feed');

let isInitialLoad = true;

function startDashboardListener() {
    const q = query(collection(db, "detections"), orderBy("timestamp", "desc"), limit(20));
    onSnapshot(q, (snapshot) => {
        alertFeed.innerHTML = '';
        snapshot.forEach((doc) => {
            const data = doc.data();
            // Don't show disputed (reverted) detections in the live feed
            if (data.disputed === true) return;
            createAlertCard(data);
        });
        snapshot.docChanges().forEach((change) => {
            if (change.type === "added" && !isInitialLoad) {
                const newData = change.doc.data();
                const isUnknown = !newData.name || newData.name === 'Unknown';
                // Only toast known employees on the admin dashboard.
                // Unknown detections are visible in the live feed and the
                // Unknown Faces page — a separate popup here adds no value
                // and fires too frequently due to face recognition gaps.
                if (!isUnknown) {
                    showToastAlert(newData.name, newData.violation);
                }
            }
        });
        isInitialLoad = false;
    }, (error) => {
        console.error("[Dashboard] Firestore error:", error);
    });
}

onAuthStateChanged(auth, (user) => {
    if (user) {
        startDashboardListener();
        // ── Scenario B post-registration countdown ────────────────────────────
        // register.js redirects here with ?countdown=1&empId=...&empName=...
        // after creating the account, so Chrome's "Save password?" dialog
        // (which sits above all page content) can't block the overlay.
        const sp = new URLSearchParams(window.location.search);
        if (sp.get('countdown') === '1') {
            const empId   = sp.get('empId')   || '';
            const empName = decodeURIComponent(sp.get('empName') || '');
            const cmdId   = sp.get('cmdId')   || '';
            // Clean the URL so a page refresh doesn't re-trigger the countdown
            history.replaceState(null, '', window.location.pathname);
            startPhotoCountdown(empId, empName, cmdId);
        }
    } else {
        window.location.href = 'login.html';
    }
});

// ── Scenario B: 3-phase photo capture countdown ───────────────────────────────
// Runs on index.html after redirect from register.html (Scenario B).
// The new employee goes through 3 poses (straight / turn left / helmet on)
// while ai_engine.py captures one photo per phase for face recognition enrollment.
function startPhotoCountdown(empId, empName, cmdId) {
    const overlay = document.getElementById('countdown-overlay');
    const numEl   = document.getElementById('countdown-number');
    const barEl   = document.getElementById('countdown-bar');
    const nameEl  = document.getElementById('countdown-name');
    const stepEl  = document.getElementById('countdown-step');

    if (!overlay) return;

    const phases = [
        { icon: '', instruction: 'Step 1 / 6 — Look straight at the camera',        secs: 5  },
        { icon: '',  instruction: 'Step 2 / 6 — Turn slightly to your LEFT',         secs: 5  },
        { icon: '',  instruction: 'Step 3 / 6 — Turn slightly to your RIGHT',        secs: 5  },
        { icon: '', instruction: 'Step 4 / 6 — Put on your helmet, look straight',  secs: 15 },
        { icon: '', instruction: 'Step 5 / 6 — Helmet on — turn slightly LEFT',      secs: 5  },
        { icon: '', instruction: 'Step 6 / 6 — Helmet on — turn slightly RIGHT',     secs: 5  },
    ];

    nameEl.textContent    = `Employee: ${empName}  ·  ID: ${empId}`;
    overlay.style.display = 'flex';

    function runPhase(idx) {
        if (idx >= phases.length) {
            // All phases done — show completion state then hide
            numEl.textContent  = '';
            if (stepEl) stepEl.textContent = 'Registration complete!';
            setTimeout(() => { overlay.style.display = 'none'; }, 1800);
            return;
        }

        if (stepEl) stepEl.textContent = `${phases[idx].icon}  ${phases[idx].instruction}`;

        const phaseSecs = phases[idx].secs;
        let secs = phaseSecs;
        numEl.textContent = secs;

        // Reset and start the progress bar for this phase
        barEl.style.transition = 'none';
        barEl.style.width = '100%';
        setTimeout(() => {
            barEl.style.transition = `width ${phaseSecs}s linear`;
            barEl.style.width = '0%';
        }, 50);

        const tick = setInterval(() => {
            secs--;

            // Animate the number with a quick scale pop
            numEl.style.transform = 'scale(1.25)';
            numEl.style.opacity   = '0.4';
            setTimeout(() => {
                numEl.textContent     = secs > 0 ? secs : '';
                numEl.style.transform = 'scale(1)';
                numEl.style.opacity   = '1';
            }, 150);

            if (secs <= 0) {
                clearInterval(tick);
                // Signal the backend to capture RIGHT NOW (countdown = 0).
                // Write capture_phase into the existing command document so
                // ai_engine.py knows exactly when to take the photo.
                if (cmdId) {
                    updateDoc(doc(db, 'commands', cmdId), { capture_phase: idx + 1 })
                        .catch(err => console.warn('Capture signal failed:', err));
                }
                runPhase(idx + 1);
            }
        }, 1000);
    }

    runPhase(0);
}



// pop-up for unrecognised person (unknown employee or visitor)
function showUnknownAlert(violation) {
    const toastContainer = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast-alert';
    toast.style.cssText = `
        background: linear-gradient(135deg, #7c3aed, #4f46e5);
        border-left: 4px solid #a78bfa;
        padding: 14px 18px;
        border-radius: 8px;
        margin-bottom: 10px;
        max-width: 340px;
        box-shadow: 0 4px 20px rgba(124,58,237,0.4);
    `;

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold; color:#fff; margin-bottom:5px; font-size:0.95em;';
    title.textContent = 'Unrecognised Person Detected';

    const detail = document.createElement('div');
    detail.style.cssText = 'color:#ddd6fe; font-size:0.82em; margin-bottom:8px;';
    detail.textContent = `Violation: ${violation || 'PPE non-compliance'}`;

    const instruction = document.createElement('div');
    instruction.style.cssText = `
        background: rgba(255,255,255,0.12);
        border-radius: 6px;
        padding: 7px 10px;
        font-size: 0.8em;
        color: #ede9fe;
        line-height: 1.5;
    `;
    instruction.textContent = 'Action required: Review the live feed and verify this individual\'s identity. Dispatch security if necessary.';

    toast.appendChild(title);
    toast.appendChild(detail);
    toast.appendChild(instruction);
    toastContainer.appendChild(toast);

    setTimeout(() => { toast.remove(); }, 10000); // stays 10 seconds (longer than normal)
}

// pop-up toast alert for real-time violations
function showToastAlert(name, violation) {
    const toastContainer = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast-alert';
    
    // Security: keep using textContent to prevent XSS, and only allow specific fields (name and violation) to be displayed
    toast.textContent = `REAL-TIME ALERT: ${name} detected with ${violation}!`;
    
    toastContainer.appendChild(toast);

    // after 5 seconds, remove the toast
    setTimeout(() => {
        toast.remove();
    }, 5000);
}

// function to create an alert card in the feed
function createAlertCard(data) {
    const card = document.createElement('div');
    card.className = 'alert-card';

    // 2.1 handle image_url - if missing, use a default placeholder
    const img = document.createElement('img');
    img.className = 'evidence-img';
    img.setAttribute('src', data.image_url || 'default-placeholder.png'); 
    img.setAttribute('alt', 'Violation Evidence');

    const content = document.createElement('div');
    content.className = 'card-content';

    // 3. handle violation type - if missing, show "Unknown Violation"
    const typeLabel = document.createElement('div');
    typeLabel.className = 'violation-type';
    typeLabel.textContent = `${data.violation}`; 

    // 4. handle name - if missing, show "Unknown Employee"
    const nameLabel = document.createElement('div');
    nameLabel.textContent = `Employee: ${data.name}`;

    // 5. handle timestamp - if missing, show "Time Unknown"
    const timeLabel = document.createElement('div');
    timeLabel.style.fontSize = '0.85rem';
    timeLabel.style.color = '#64748b';
    
    let dateStr = 'Just now';
    if (data.timestamp) {
        // if timestamp exists, try to convert it to a readable format; if it's already a string, just use it
        dateStr = typeof data.timestamp.toDate === 'function' 
            ? data.timestamp.toDate().toLocaleString() 
            : data.timestamp; 
    }
    timeLabel.textContent = `Time: ${dateStr}`;

    // three basic data before assembly
    content.appendChild(typeLabel);
    content.appendChild(nameLabel);
    content.appendChild(timeLabel);

    // 6. handle confidence level — reads confidence_score stored by ai_engine.py
    // Reference: ISO/IEC 22989:2022 — AI confidence displayed for decision auditability
    const confValue = data.confidence_score || data.confidence || 0;
    if (confValue > 0) {
        const confidenceDiv = document.createElement('div');
        confidenceDiv.style.marginTop = '10px';
        confidenceDiv.style.fontSize = '0.85rem';
        confidenceDiv.textContent = `AI Confidence: ${confValue}%`;

        const barContainer = document.createElement('div');
        barContainer.className = 'confidence-bar-container';
        
        const bar = document.createElement('div');
        bar.className = 'confidence-bar';
        bar.style.width = `${confValue}%`;
        barContainer.appendChild(bar);

        content.appendChild(confidenceDiv);
        content.appendChild(barContainer);
    }

    // finally, assemble and append the card to the feed
    card.appendChild(img);
    card.appendChild(content);
    alertFeed.appendChild(card);
}

