import cv2
import os
import datetime
import numpy as np
import face_recognition
from ultralytics import YOLO
import time
import threading

import database_manager
from database_manager import db

SHARED_STATE = {
    "current_mode": "DETECTING",
    "global_frame": None,           # JPEG bytes — used by /stream endpoint
    "global_frame_lock": threading.Lock(),
    "raw_frame": None,              # numpy array — used by registration capture thread
    "raw_frame_lock": threading.Lock(),
    "target_employee_id": "",
    "target_employee_name": "",
    "target_doc_id": "",
    "capture_phase": 0,             # set by Firestore listener when frontend countdown hits 0
}

# Face recognition runs in background — main loop reads these without blocking
_face_lock = threading.Lock()
_face_locations = []
_face_ids = []
_face_last_updated = 0.0   # timestamp of last completed face recognition run

# Module-level flag — must be module-level so the background thread can set it
# with `global` and the main loop in run_safety_violation() reads the same variable.
# If this were a local inside run_safety_violation(), `global` in the nested
# _run_and_clear() closure would refer to a DIFFERENT (module) scope and the main
# loop would never see the flag cleared → face recognition would only ever run once.
_face_worker_running = False

# Cache Firestore name lookups so we don't hit the network every frame
_name_cache = {}

# ── Violation cooldown tracker ────────────────────────────────────────────────
# Prevents the same (employee, violation_type) pair from being logged more than
# once within COOLDOWN_SECONDS, even if it appears in every camera frame.
# Reference: ISO 45001:2018 Clause 9.1 — meaningful, non-duplicate incident records.
COOLDOWN_SECONDS = 60
_last_log_time = {}   # key: (emp_id, violation_type) → timestamp of last log

def _is_on_cooldown(emp_id, violation_type):
    key = (emp_id, violation_type)
    last = _last_log_time.get(key, 0)
    return (time.time() - last) < COOLDOWN_SECONDS

def _mark_logged(emp_id, violation_type):
    _last_log_time[(emp_id, violation_type)] = time.time()

# ── Face recognition grace-period tracker ────────────────────────────────────
# Face recognition runs in a background thread and takes 1–3 seconds per frame.
# During that gap the result is still "Unknown" from the previous run.
# Without this guard, the system logs two violations for the same event:
#   1. "Unknown" (face recognition hasn't finished yet)
#   2. "EMP001"  (face recognition just returned the correct ID)
# That causes DOUBLE score deduction when admin reassigns the Unknown record.
#
# Fix: track the last time a KNOWN (non-Unknown) ID was returned for each
# violation type. If a known employee was identified within FACE_GRACE_SECONDS,
# use their ID even when the current face recognition result says "Unknown".
# This is safe for single-person checkpoint deployments (one person at a time).
FACE_GRACE_SECONDS = 20   # seconds to remember the last known face ID
_last_known_id   = {}     # key: violation_type → last non-Unknown emp_id
_last_known_time = {}     # key: violation_type → timestamp of last known-ID result

# ── Delayed Unknown logging ───────────────────────────────────────────────────
# When face recognition returns Unknown, we don't log immediately.
# We queue the violation for UNKNOWN_LOG_DELAY seconds.
# If a known employee is identified for the same violation type within that
# window, the Unknown entry is suppressed — preventing double-deduction when
# HR later reassigns the Unknown record.
UNKNOWN_LOG_DELAY = 5    # seconds to wait before committing an Unknown log
_pending_unknowns = {}   # key: violation_type → {time, frame, conf}

def _queue_unknown(violation_type, frame, conf):
    """Queue an Unknown violation — only log after UNKNOWN_LOG_DELAY if still unresolved."""
    if violation_type not in _pending_unknowns:
        _pending_unknowns[violation_type] = {
            'time':  time.time(),
            'frame': frame.copy(),
            'conf':  conf,
        }

def _flush_pending_unknowns():
    """
    Called every frame. Commits any queued Unknown violations whose delay has
    elapsed AND for which no known employee was identified in the meantime.
    """
    now = time.time()
    resolved = []
    for vtype, pending in list(_pending_unknowns.items()):
        if now - pending['time'] < UNKNOWN_LOG_DELAY:
            continue  # still waiting
        resolved.append(vtype)
        # If a known ID surfaced AFTER the Unknown was queued, suppress the Unknown
        last_known_t = _last_known_time.get(vtype, 0)
        if last_known_t >= pending['time']:
            known = _last_known_id.get(vtype, '?')
            print(f"🔄 Suppressed Unknown '{vtype}' — {known} identified within grace window")
        else:
            # Still genuinely Unknown after delay — log it
            if not _is_on_cooldown("Unknown", vtype):
                _mark_logged("Unknown", vtype)
                threading.Thread(
                    target=database_manager.log_detection,
                    args=("Unknown", vtype, pending['frame'], pending['conf'])
                ).start()
    for vtype in resolved:
        del _pending_unknowns[vtype]

def _resolve_user_id(raw_id: str, violation_type: str) -> str:
    """
    If raw_id is a known employee, update the grace-period tracker and return it.
    If raw_id is "Unknown" but a known employee was seen recently, return that
    employee's ID instead — preventing the double-log bug.
    If raw_id is "Unknown" and no known employee was seen recently, return "Unknown".
    """
    if raw_id != "Unknown":
        # Known employee — update tracker
        _last_known_id[violation_type]   = raw_id
        _last_known_time[violation_type] = time.time()
        return raw_id

    # raw_id is Unknown — check grace period
    last_time = _last_known_time.get(violation_type, 0)
    if time.time() - last_time < FACE_GRACE_SECONDS:
        grace_id = _last_known_id.get(violation_type, "Unknown")
        if grace_id != "Unknown":
            print(f"🔄 [Grace] Face recognition gap — using cached ID '{grace_id}' "
                  f"instead of Unknown for {violation_type}")
            return grace_id

    return "Unknown"

def _get_real_name_cached(emp_id):
    if emp_id not in _name_cache:
        _name_cache[emp_id] = database_manager.get_real_name(emp_id)
    return _name_cache[emp_id]

# ── Unknown face presence alert ───────────────────────────────────────────────
# Writes to `unknown_alerts` collection whenever an Unknown face is detected,
# regardless of PPE status. public-display.html listens to this collection.
# Separate from the violation cooldown so it fires reliably.
UNKNOWN_ALERT_COOLDOWN = 30   # seconds between alerts (avoids Firestore spam)
_last_unknown_alert_time = 0.0

def _maybe_fire_unknown_alert():
    """Write a lightweight document to unknown_alerts if cooldown has expired."""
    global _last_unknown_alert_time
    now = time.time()
    if now - _last_unknown_alert_time < UNKNOWN_ALERT_COOLDOWN:
        return
    _last_unknown_alert_time = now
    try:
        database_manager.db.collection("unknown_alerts").add({
            "timestamp": database_manager.firestore.SERVER_TIMESTAMP,
        })
        print("🔔 Unknown alert fired → public display")
    except Exception as ex:
        print(f"⚠️  Unknown alert write failed: {ex}")

def _face_recognition_worker(rgb_small_frame, known_face_encodings, known_face_names):
    """Runs in a background thread — never blocks the camera loop."""
    global _face_locations, _face_ids
    # Full-resolution frame — upsample=1 is sufficient and much faster than upsample=2
    locs = face_recognition.face_locations(rgb_small_frame, number_of_times_to_upsample=1)
    encs = face_recognition.face_encodings(rgb_small_frame, locs)

    ids = []
    for enc in encs:
        emp_id = "Unknown"
        distances = face_recognition.face_distance(known_face_encodings, enc)
        if len(distances) > 0:
            # ── Voting consensus ──────────────────────────────────────────────
            # With multiple reference photos per employee, a single-closest-match
            # approach is unreliable — one bad encoding can cause a false positive.
            # Instead we count how many of each employee's reference photos fall
            # within the threshold.  The employee with the MOST votes wins,
            # but only if they have at least MIN_VOTES matching photos.
            # This prevents a completely different face from matching on a single
            # lucky side-profile encoding.
            # Reference: ISO/IEC 22989:2022 — ensemble agreement for AI decisions.
            THRESHOLD  = 0.42   # strict — reduces false positives from weak encodings
            MIN_VOTES  = 3      # at least 2 reference photos must agree

            # Count votes per employee
            vote_counts = {}     # emp_id → number of photos within threshold
            vote_best   = {}     # emp_id → best (lowest) distance seen

            for dist, name in zip(distances, known_face_names):
                if dist < THRESHOLD:
                    vote_counts[name] = vote_counts.get(name, 0) + 1
                    if name not in vote_best or dist < vote_best[name]:
                        vote_best[name] = dist

            if vote_counts:
                # Pick the employee with the most votes; tie-break by best distance
                winner = max(vote_counts, key=lambda n: (vote_counts[n], -vote_best[n]))
                if vote_counts[winner] >= MIN_VOTES:
                    emp_id = winner
                    print(f"✅ Recognised: {winner}  votes={vote_counts[winner]}  "
                          f"best_dist={vote_best[winner]:.4f}")
                else:
                    print(f"⚠️  Weak match: {winner}  votes={vote_counts[winner]} "
                          f"(need {MIN_VOTES}) → Unknown")
            else:
                print(f"🔍 No face within threshold {THRESHOLD} → Unknown")

        ids.append(emp_id)

    with _face_lock:
        _face_locations = locs
        _face_ids = ids
        _face_last_updated = time.time()

_SERVER_START_TIME = datetime.datetime.now(datetime.timezone.utc)

def on_command_snapshot(col_snapshot, changes, read_time):
    """Listen for photo-registration commands sent from the frontend."""
    for change in changes:
        # Frontend writes capture_phase into the command doc when countdown hits 0.
        # Pick that up and store in SHARED_STATE so the capture thread can react.
        if change.type.name == 'MODIFIED':
            if change.document.id == SHARED_STATE.get("target_doc_id"):
                data = change.document.to_dict()
                phase = data.get('capture_phase', 0)
                if phase and SHARED_STATE.get("current_mode") == "REGISTERING":
                    SHARED_STATE["capture_phase"] = phase
                    print(f"📡 Capture signal received: phase {phase}/6")
            continue

        if change.type.name == 'ADDED':
            data = change.document.to_dict()
            if data.get('action') != 'capture_photo':
                continue
            if data.get('status') in ('completed', 'failed'):
                continue

            # Ignore commands created before this server session started.
            # Firestore replays ALL existing documents as ADDED when a listener
            # first connects — without this guard, old pending commands from
            # previous registrations fire every time Python restarts.
            ts = data.get('timestamp')
            if ts:
                cmd_time = ts if hasattr(ts, 'tzinfo') and ts.tzinfo else ts.replace(tzinfo=datetime.timezone.utc)
                if hasattr(ts, 'ToDatetime'):  # Firestore Timestamp object
                    cmd_time = ts.ToDatetime(tzinfo=datetime.timezone.utc)
                if cmd_time < _SERVER_START_TIME:
                    # Mark old pending command so it never fires again
                    db.collection("commands").document(change.document.id).update({"status": "failed"})
                    continue

            SHARED_STATE["target_employee_id"] = data.get('target_id')
            SHARED_STATE["target_employee_name"] = data.get('target_name')
            SHARED_STATE["target_doc_id"] = change.document.id
            print(f"🔔 Registration command received: {SHARED_STATE['target_employee_name']} ({SHARED_STATE['target_employee_id']})")
            SHARED_STATE["current_mode"] = "REGISTERING"

def run_safety_violation():
    """Main visual engine."""
    global _face_locations, _face_ids

    # ── Consecutive-frame threshold ───────────────────────────────────────────
    # Require N consecutive frames with the same violation before logging it.
    # THRESHOLD = 1 caused one log per frame (potentially 30+ logs/second).
    # THRESHOLD = 8 means ~0.25 s of sustained violation at 30 fps — enough to
    # confirm a genuine non-compliance rather than a momentary mis-detection.
    # Reference: ISO 45001:2018 Clause 8.2 — proportionate hazard response.
    THRESHOLD = 8
    helmet_violation_count = 0
    vest_violation_count = 0

    try:
        model = YOLO("best.pt")
        model.to('cuda')
        print("✅ YOLO model loaded (GPU: CUDA)")
    except Exception as e:
        print(f"❌ YOLO load failed: {e}")
        return

    # ── Load known faces ──────────────────────────────────────────────────────
    # IMPORTANT: The image filename (without extension) MUST match the employee's
    # `id` field stored in Firestore. For example, if Firestore has id = "emp001",
    # the face image file must be named  known_faces/emp001.jpg
    # If the name doesn't match, the employee will show as "Unknown" on screen.
    # The system auto-saves correctly-named files when you use the in-app
    # registration flow (REGISTERING mode). Manual uploads must follow this rule.
    known_face_encodings = []
    known_face_names = []
    known_faces_dir = "known_faces"
    os.makedirs(known_faces_dir, exist_ok=True)

    print("\n📂 Loading known faces from:", os.path.abspath(known_faces_dir))
    for filename in os.listdir(known_faces_dir):
        if filename.lower().endswith((".jpg", ".png", ".jpeg")):
            # Support multiple reference photos per employee:
            # EMP001.jpg, EMP001_a.jpg, EMP001_b.jpg all map to emp_id = "EMP001"
            base = os.path.splitext(filename)[0]          # e.g. "EMP001_a"
            emp_id = base.split('_')[0].upper()           # e.g. "EMP001"
            img_path = os.path.join(known_faces_dir, filename)
            try:
                img = face_recognition.load_image_file(img_path)
                encs = face_recognition.face_encodings(img)
                if encs:
                    known_face_encodings.append(encs[0])
                    known_face_names.append(emp_id)
                    print(f"   ✅ Loaded: {filename}  →  ID mapped to '{emp_id}'")
                else:
                    print(f"   ⚠️  No face detected in {filename} — skipped. "
                          f"Make sure the image shows a clear frontal face.")
            except Exception as ex:
                print(f"   ❌ Failed to load {filename}: {ex}")

    if not known_face_encodings:
        print("⚠️  WARNING: No known faces loaded. All detections will show as 'Unknown'.")
    else:
        print(f"✅ {len(known_face_encodings)} known face(s) loaded.\n")

    db.collection("commands").on_snapshot(on_command_snapshot)

    cap = cv2.VideoCapture(0)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

    small_frame = None

    # Multi-phase registration state — stored in SHARED_STATE so the background
    # capture thread can read it and update the overlay phase label on the dashboard.
    SHARED_STATE["registering_captured"] = False   # True once the capture thread is launched
    SHARED_STATE["register_phase"]       = 0       # 1 / 2 / 3 — which pose is active

    print("🎥 Sentinel-Eye vision engine started!")

    try:
        frame_count = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            frame_count += 1

            # Keep a raw numpy copy for the registration capture thread
            with SHARED_STATE["raw_frame_lock"]:
                SHARED_STATE["raw_frame"] = frame.copy()

            mode = SHARED_STATE["current_mode"]

            if mode == "PAUSED":
                cv2.putText(frame, "STOP RECORDING (PAUSED)", (20, 80),
                            cv2.FONT_HERSHEY_DUPLEX, 1, (0, 165, 255), 3)

            elif mode == "REGISTERING":
                emp_id   = SHARED_STATE["target_employee_id"]
                emp_name = SHARED_STATE["target_employee_name"]

                # Show the current phase label on the video overlay
                phase_labels = {
                    1: "STEP 1/6: LOOK STRAIGHT",
                    2: "STEP 2/6: TURN LEFT",
                    3: "STEP 3/6: TURN RIGHT",
                    4: "STEP 4/6: HELMET ON - STRAIGHT",
                    5: "STEP 5/6: HELMET ON - LEFT",
                    6: "STEP 6/6: HELMET ON - RIGHT",
                }
                phase = SHARED_STATE.get("register_phase", 1)
                label = phase_labels.get(phase, f"REGISTERING: {emp_name}...")
                cv2.putText(frame, label, (20, 50),
                            cv2.FONT_HERSHEY_DUPLEX, 1, (0, 165, 255), 3)

                if not SHARED_STATE["registering_captured"]:
                    SHARED_STATE["registering_captured"] = True
                    SHARED_STATE["register_phase"]       = 1

                    def _multi_capture(eid, ename, doc_id,
                                       face_encodings=known_face_encodings,
                                       face_names=known_face_names):
                        """
                        Capture 6 reference photos for a new employee:
                          Phase 1 — straight (no helmet)   → EMP001.jpg
                          Phase 2 — left     (no helmet)   → EMP001_b.jpg
                          Phase 3 — right    (no helmet)   → EMP001_c.jpg
                          Phase 4 — helmet on, straight    → EMP001_d.jpg  (15 s to put helmet on)
                          Phase 5 — helmet on, left        → EMP001_e.jpg
                          Phase 6 — helmet on, right       → EMP001_f.jpg
                        Phases 1-3: HOG face detection required (no helmet blocks forehead).
                        Phases 4-6: photo saved regardless — helmet covers forehead so HOG
                          is unreliable; photos still add visual reference diversity.
                        """
                        # Sleep durations must match the frontend phase timers in dashboard.js
                        # (suffix, phase number, sleep seconds, require face encoding)
                        poses = [("",   1,  5),
                                 ("_b", 2,  5),
                                 ("_c", 3,  5),
                                 ("_d", 4, 15),
                                 ("_e", 5,  5),
                                 ("_f", 6,  5)]
                        captured = 0
                        SHARED_STATE["capture_phase"] = 0

                        for suffix, phase_num, phase_sleep in poses:
                            SHARED_STATE["register_phase"] = phase_num

                            # Wait for the frontend to signal countdown = 0 for this phase.
                            # Timeout = phase duration + 10 s buffer in case of slow network.
                            timeout = phase_sleep + 10
                            start   = time.time()
                            while time.time() - start < timeout:
                                if SHARED_STATE.get("capture_phase") == phase_num:
                                    break
                                time.sleep(0.05)
                            else:
                                print(f"⚠️  Phase {phase_num}/6: no signal received, skipped")
                                continue
                            SHARED_STATE["capture_phase"] = 0  # reset for next phase

                            with SHARED_STATE["raw_frame_lock"]:
                                f = SHARED_STATE["raw_frame"]
                                if f is not None:
                                    f = f.copy()

                            if f is None:
                                print(f"⚠️  Phase {phase_num}/6: no frame, skipped")
                                continue

                            fpath = os.path.join(known_faces_dir, f"{eid}{suffix}.jpg")
                            cv2.imwrite(fpath, f)

                            try:
                                img  = face_recognition.load_image_file(fpath)
                                encs = face_recognition.face_encodings(img)
                                if encs:
                                    face_encodings.append(encs[0])
                                    face_names.append(eid)
                                    _name_cache[eid] = ename
                                    captured += 1
                                    print(f"✅ Phase {phase_num}/6: face encoded")
                                else:
                                    os.remove(fpath)
                                    print(f"⚠️  Phase {phase_num}/6: no face detected, skipped")
                            except Exception as ex:
                                print(f"❌ Phase {phase_num}/6 error: {ex}")

                        # Mark command as completed / failed in Firestore
                        if doc_id:
                            status = "completed" if captured > 0 else "failed"
                            db.collection("commands").document(doc_id).update({"status": status})

                        # Wait for the frontend ✅ completion screen to finish
                        # before switching the camera back to PAUSED mode
                        time.sleep(3)

                        # Reset registration state and return to PAUSED
                        SHARED_STATE["register_phase"]       = 0
                        SHARED_STATE["registering_captured"] = False
                        SHARED_STATE["current_mode"]         = "PAUSED"
                        print(f"✅ Multi-photo registration done: {captured}/6 photos for {ename}")

                    threading.Thread(
                        target=_multi_capture,
                        args=(emp_id, emp_name, SHARED_STATE["target_doc_id"]),
                        daemon=True
                    ).start()

            elif mode == "DETECTING":
                cv2.putText(frame, "SYSTEM ACTIVE: DETECTING", (20, 80),
                            cv2.FONT_HERSHEY_DUPLEX, 1, (0, 255, 0), 3)

                # YOLO uses a small frame for speed
                small_frame = cv2.resize(frame, (0, 0), fx=0.5, fy=0.5)

                # Face recognition uses the FULL-resolution frame so face_locations()
                # can actually detect faces — at smaller scales HOG misses them.
                # Running in background so it never blocks the camera loop.
                # _face_worker_running is MODULE-level so the thread's `global` assignment
                # is visible to this loop on the next iteration.
                global _face_worker_running
                if not _face_worker_running:
                    _face_worker_running = True
                    rgb_full = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

                    def _run_and_clear(rgb):
                        global _face_worker_running
                        _face_recognition_worker(rgb, known_face_encodings, known_face_names)
                        _face_worker_running = False

                    threading.Thread(target=_run_and_clear, args=(rgb_full,), daemon=True).start()

                # Read latest face results (non-blocking — uses whatever last run produced).
                # No staleness check: full-res face recognition on CPU can take several
                # seconds; clearing the result while it's computing causes false "Unknown".
                # The cooldown + THRESHOLD guards in the violation logger already prevent
                # mis-attribution spam.
                with _face_lock:
                    cur_locations = list(_face_locations)
                    cur_ids       = list(_face_ids)

                # YOLO runs every frame on GPU — fast
                results = model(small_frame, stream=True, conf=0.60, imgsz=480, verbose=False)
                raw_user_id = cur_ids[0] if cur_ids else "Unknown"

                # Fire a lightweight unknown_alerts document whenever an Unknown
                # face is detected — public-display.html listens to this collection
                # so the entrance screen popup works regardless of PPE status.
                if raw_user_id == "Unknown" and cur_ids:
                    threading.Thread(target=_maybe_fire_unknown_alert, daemon=True).start()

                for r in results:
                    frame = r.plot()
                    found_labels = [model.names[int(box.cls)] for box in r.boxes]

                    # Feature 8: Extract person detection confidence for auditability.
                    # Reference: ISO/IEC 22989:2022 — AI confidence for decision transparency.
                    person_conf = 0.0
                    for box in r.boxes:
                        if model.names[int(box.cls)] == 'person':
                            person_conf = round(float(box.conf[0]) * 100, 1)
                            break

                    if 'person' in found_labels:
                        no_helmet = 'helmet' not in found_labels
                        no_vest   = 'vest'   not in found_labels

                        # Flush any queued Unknown violations every frame
                        _flush_pending_unknowns()

                        if no_helmet and no_vest:
                            # ── Combined: No Helmet & No Vest ─────────────────
                            cv2.putText(frame, "WARNING: NO HELMET & NO VEST", (20, 90),
                                        cv2.FONT_HERSHEY_DUPLEX, 0.9, (0, 0, 255), 3)
                            helmet_violation_count += 1
                            vest_violation_count   += 1
                            if helmet_violation_count >= THRESHOLD and vest_violation_count >= THRESHOLD:
                                combined_user_id = _resolve_user_id(raw_user_id, "No Helmet & No Vest")
                                if not _is_on_cooldown(combined_user_id, "No Helmet & No Vest"):
                                    if combined_user_id == "Unknown":
                                        # Delay Unknown log — suppress if employee ID surfaces within 5s
                                        _queue_unknown("No Helmet & No Vest", frame, person_conf)
                                    else:
                                        _mark_logged(combined_user_id, "No Helmet & No Vest")
                                        threading.Thread(
                                            target=database_manager.log_detection,
                                            args=(combined_user_id, "No Helmet & No Vest", frame.copy(), person_conf)
                                        ).start()
                                helmet_violation_count = 0
                                vest_violation_count   = 0

                        else:
                            # ── Individual checks ─────────────────────────────
                            if no_helmet:
                                cv2.putText(frame, "WARNING: NO HELMET", (20, 90),
                                            cv2.FONT_HERSHEY_DUPLEX, 1, (0, 0, 255), 3)
                                helmet_violation_count += 1
                                if helmet_violation_count >= THRESHOLD:
                                    helmet_user_id = _resolve_user_id(raw_user_id, "No Helmet")
                                    if not _is_on_cooldown(helmet_user_id, "No Helmet"):
                                        if helmet_user_id == "Unknown":
                                            _queue_unknown("No Helmet", frame, person_conf)
                                        else:
                                            _mark_logged(helmet_user_id, "No Helmet")
                                            threading.Thread(
                                                target=database_manager.log_detection,
                                                args=(helmet_user_id, "No Helmet", frame.copy(), person_conf)
                                            ).start()
                                    helmet_violation_count = 0
                            else:
                                helmet_violation_count = 0

                            if no_vest:
                                cv2.putText(frame, "WARNING: NO VEST", (20, 130),
                                            cv2.FONT_HERSHEY_DUPLEX, 1, (0, 0, 255), 3)
                                vest_violation_count += 1
                                if vest_violation_count >= THRESHOLD:
                                    vest_user_id = _resolve_user_id(raw_user_id, "No Vest")
                                    if not _is_on_cooldown(vest_user_id, "No Vest"):
                                        if vest_user_id == "Unknown":
                                            _queue_unknown("No Vest", frame, person_conf)
                                        else:
                                            _mark_logged(vest_user_id, "No Vest")
                                            threading.Thread(
                                                target=database_manager.log_detection,
                                                args=(vest_user_id, "No Vest", frame.copy(), person_conf)
                                            ).start()
                                    vest_violation_count = 0
                            else:
                                vest_violation_count = 0

                # Draw face boxes using last known results (smooth — no stutter).
                # Face recognition ran on the full 1280×720 frame, but r.plot() returned
                # a 640×360 frame (0.5× scale). Divide coords by 2 to match.
                for (top, right, bottom, left), emp_id in zip(cur_locations, cur_ids):
                    top, right, bottom, left = top//2, right//2, bottom//2, left//2
                    cv2.rectangle(frame, (left, top), (right, bottom), (255, 0, 0), 2)
                    real_name = _get_real_name_cached(emp_id)
                    cv2.putText(frame, real_name, (left, top - 10),
                                cv2.FONT_HERSHEY_DUPLEX, 0.7, (255, 0, 0), 2)

            elif mode == "STANDBY":
                frame[:] = (15, 23, 42)
                cv2.putText(frame, "SYSTEM IN STANDBY MODE", (50, 360),
                            cv2.FONT_HERSHEY_DUPLEX, 1.5, (148, 163, 184), 3)

            # Push encoded frame to MJPEG stream
            ret_jpg, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if ret_jpg:
                with SHARED_STATE["global_frame_lock"]:
                    SHARED_STATE["global_frame"] = buffer.tobytes()

    except KeyboardInterrupt:
        pass
    finally:
        cap.release()
