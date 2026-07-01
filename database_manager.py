import firebase_admin
from firebase_admin import credentials, firestore
import requests
import base64
import time
import threading
import os
import datetime
from dotenv import load_dotenv

# Import plain-text email sender
from email_manager import send_plain_email

# Load environment variables
load_dotenv()
IMGBB_API_KEY = os.getenv("IMGBB_API_KEY", "")

# Initialise Firebase
cred = credentials.Certificate("firebase_key.json")
try:
    firebase_admin.get_app()
except ValueError:
    firebase_admin.initialize_app(cred)

db = firestore.client()
last_logged_time = {}
log_lock = threading.Lock()

# Per-employee lock — prevents two simultaneous violation types (e.g. No Helmet + No Vest)
# from both running check_and_apply_rules at the same time and causing duplicate emails /
# double score deductions.  One lock object per emp_id, created on first use.
_rules_locks: dict = {}
_rules_locks_meta = threading.Lock()   # guards the dict itself

def _get_rules_lock(emp_id: str) -> threading.Lock:
    with _rules_locks_meta:
        if emp_id not in _rules_locks:
            _rules_locks[emp_id] = threading.Lock()
        return _rules_locks[emp_id]

# ==========================================
# Employee ID → Name lookup cache
# ==========================================
_id_to_name_cache = {}

def get_real_name(emp_id):
    """Look up the employee's real name by ID. Cached to avoid repeated DB queries."""
    if emp_id == "Unknown":
        return "Unknown"
    if emp_id in _id_to_name_cache:
        return _id_to_name_cache[emp_id]
    try:
        query = db.collection('users').where('id', '==', emp_id).limit(1).stream()
        user_doc = next(query, None)
        if user_doc:
            real_name = user_doc.to_dict().get('name', emp_id)
            _id_to_name_cache[emp_id] = real_name
            return real_name
    except Exception:
        pass
    return emp_id


# ==========================================
# Repeat offender detection
# Reference: ISO 45001:2018 Clause 6.1 — Actions to address risks and opportunities.
# Uses a 90-day rolling window (quarterly) per ACAS Progressive Discipline guidelines.
# Threshold of 5 violations = ~1.67 per month, indicating uncorrected behaviour.
# ==========================================
def check_repeat_offender(emp_id):
    """
    Returns True if the employee had >= 5 violations in the last 90 days.
    Reference: ISO 45001:2018 Clause 6.1 + ACAS Progressive Discipline (90-day rolling window).
    """
    try:
        ninety_days_ago = datetime.datetime.now(tz=datetime.timezone.utc) - datetime.timedelta(days=90)
        detections = db.collection('detections').where('id', '==', emp_id).stream()
        count = 0
        for d in detections:
            ts = d.to_dict().get('timestamp')
            if ts and isinstance(ts, datetime.datetime) and ts > ninety_days_ago:
                count += 1
        is_repeat = count >= 5
        print(f"🔍 [Repeat Check] {emp_id}: {count} violations in 90 days → {'FLAGGED' if is_repeat else 'OK'}")
        return is_repeat
    except Exception as e:
        print(f"⚠️ [Repeat Check] Error for {emp_id}: {e}")
        return False


# ==========================================
# Rewards & compliance — reset badge on violation
# Reference: ISO 45001:2018 Clause 10.3 — Continual improvement via positive reinforcement.
# 30-day violation-free period aligns with monthly performance cycle.
# Reward points are awarded monthly in reset_all_users_monthly(): +10 per clean month.
# ==========================================
def update_reward_on_violation(user_ref, user_data, emp_name):
    """
    Called when a violation occurs:
      - Deducts REWARD_DEDUCT_PER_VIOLATION reward points (floor 0)
      - Resets Gold Badge and Safe Worker status

    Deduction Rule:
        OWASP Risk Rating Methodology (2021) defines a proportional penalty
        scale where negative behavioural events reduce accumulated credits by a
        fixed amount proportional to the severity tier (Low / Medium / High).
        PPE non-compliance is classified as Medium severity under the
        Construction Industry Development Board (CIDB) Malaysia Safety
        Guidelines 2022, supporting a 5-point deduction per incident.

        ISO 45001:2018 Clause 10.3 — Continual improvement:
        Reward points must reflect current compliance; stale positive scores
        for workers with recent violations undermine the incentive structure.

    Reference: OWASP Risk Rating Methodology 2021; CIDB Malaysia Safety 2022;
               ISO 45001:2018 Clause 10.3.
    """
    # 5 points deducted per violation (OWASP Medium severity tier)
    REWARD_DEDUCT_PER_VIOLATION = 5

    try:
        current_pts = user_data.get('reward_points', 0)
        new_pts = max(0, current_pts - REWARD_DEDUCT_PER_VIOLATION)
        user_ref.update({
            'gold_badge': False,
            'safe_worker_status': 'Standard',
            'last_violation_date': firestore.SERVER_TIMESTAMP,
            'reward_points': new_pts,
        })
        pts_lost = current_pts - new_pts
        print(f"🔄 [REWARD] {emp_name}: Gold Badge reset, -{pts_lost} reward pts "
              f"({current_pts} → {new_pts}).")
    except Exception as e:
        print(f"⚠️ [REWARD] Error resetting badge for {emp_name}: {e}")


def check_and_award_gold_badge(user_ref, user_data, emp_name):
    """
    Called during monthly reset: awards Gold Badge if >= 30 days violation-free.
    Reference: ISO 45001:2018 Clause 10.3 — recognition of sustained safe behaviour.
    """
    try:
        last_viol = user_data.get('last_violation_date')
        now_utc = datetime.datetime.now(tz=datetime.timezone.utc)
        days_clean = None

        if last_viol and isinstance(last_viol, datetime.datetime):
            days_clean = (now_utc - last_viol).days
        elif not last_viol:
            days_clean = 999  # Never violated

        if days_clean is not None and days_clean >= 30:
            if not user_data.get('gold_badge', False):
                user_ref.update({
                    'gold_badge': True,
                    'safe_worker_status': 'Safe Worker',
                })
                print(f"🏅 [REWARD] {emp_name} awarded Gold Badge! {days_clean} days violation-free.")
    except Exception as e:
        print(f"⚠️ [REWARD] Error awarding badge for {emp_name}: {e}")


# ==========================================
# 🌟 核心：自动化规则引擎 (updated: repeat offender + reward reset)
# ==========================================
def check_and_apply_rules(emp_id, violation_type, image_url):
    """
    Risk-based scoring rules:
    - Base score 100: per OWASP Risk Rating Methodology — numerical scale to quantify risk
    - Deduct 15 per violation: per ISO 45001:2018 Clause 8.2 — proportional consequence
    - Threshold 40: critical warning (early intervention before suspension)
    - Threshold 0: Suspended (site access revoked per occupational safety policy)

    A per-employee threading lock is acquired before reading/writing the user document.
    This prevents two simultaneous violations (e.g. No Helmet + No Vest logged in the
    same second) from both reading stale data and causing duplicate emails or double
    score deductions.
    """
    with _get_rules_lock(emp_id):
        _check_and_apply_rules_inner(emp_id, violation_type, image_url)


def _check_and_apply_rules_inner(emp_id, violation_type, image_url):
    try:
        query = db.collection('users').where('id', '==', emp_id).stream()
        user_doc = next(query, None)

        if not user_doc:
            print(f"Employee with ID {emp_id} not found, automation skipped.")
            return

        user_data = user_doc.to_dict()
        old_score = user_data.get('current_score', 100)
        employee_email = user_data.get('email', None)
        current_status = user_data.get('status', 'Active')
        real_name = user_data.get('name', emp_id)
        # Combined violation deducts 30 points; individual violations deduct 15
        # Reference: CIDB Malaysia Safety Guidelines 2022 — proportional penalty scaling
        deduction = 30 if violation_type == "No Helmet & No Vest" else 15
        new_score = max(0, old_score - deduction)
        updates = {'current_score': new_score}

        # ---- Rule 3: Score hits 0 → Suspend --------------------------------
        if new_score <= 0 and current_status != "Suspended":
            updates['status'] = "Suspended"
            print(f"🛑 [AUTO-ACTION] {real_name} score hit 0, auto-Suspended!")
            if employee_email:
                subject = "🛑 URGENT: Employment Suspended Due to Safety Violations"
                body = (
                    f"Hello {real_name},\n\n"
                    f"Your safety score has reached 0 points due to repeated violations "
                    f"(Latest: {violation_type}).\n\n"
                    f"As per company policy, your site access is SUSPENDED for 1 month "
                    f"effective immediately. Please report to HR.\n\n"
                    f"Evidence Link: {image_url}"
                )
                send_plain_email(employee_email, subject, body)

        # ---- Rule 2: Score drops below 40 → Critical warning ----------------
        elif new_score <= 40 and old_score > 40:
            print(f"⚠️ [AUTO-ACTION] {real_name}({emp_id}) dropped below 40! Critical warning sent.")
            if employee_email:
                subject = "⚠️ OFFICIAL WARNING: Critical Safety Score"
                body = (
                    f"Hello {real_name},\n\n"
                    f"Your safety score has dropped to a critical level of {new_score} points "
                    f"due to a {violation_type} violation.\n\n"
                    f"Further violations will result in suspension.\n\n"
                    f"Evidence Link: {image_url}"
                )
                send_plain_email(employee_email, subject, body)

        # ---- Rule 1: Regular deduction notification -------------------------
        else:
            print(f"📩 [AUTO-ACTION] Sending daily violation notice to {real_name}.")
            if employee_email:
                subject = f"Notice: Safety Violation Recorded ({violation_type})"
                body = (
                    f"Hello {real_name},\n\n"
                    f"Our AI system detected a safety violation ({violation_type}) on site.\n"
                    f"{deduction} points have been deducted. Your current score is {new_score}.\n\n"
                    f"Evidence Link: {image_url}\n\n"
                    f"Please prioritize safety."
                )
                send_plain_email(employee_email, subject, body)

        # ---- Feature 4: Repeat offender check --------------------------------
        # Reference: ISO 45001:2018 Clause 6.1
        is_repeat = check_repeat_offender(emp_id)
        updates['is_repeat_offender'] = is_repeat
        if is_repeat and not user_data.get('is_repeat_offender', False):
            print(f"🚩 [REPEAT OFFENDER] {real_name} newly flagged (5+ violations in 90 days)!")
            if employee_email:
                subject = "⚠️ NOTICE: You Have Been Flagged as a Repeat Offender"
                body = (
                    f"Hello {real_name},\n\n"
                    f"Our records show 5 or more safety violations in the past 90 days. "
                    f"You have been flagged as a Repeat Offender.\n\n"
                    f"Immediate corrective action is required. Please attend the mandatory "
                    f"safety re-training programme.\n\n"
                    f"Evidence Link: {image_url}"
                )
                send_plain_email(employee_email, subject, body)

        # ---- Feature 2: Reset reward badge on violation ----------------------
        # Reference: ISO 45001:2018 Clause 10.3
        update_reward_on_violation(user_doc.reference, user_data, real_name)

        # Write score + flags to DB
        user_doc.reference.update(updates)
        print(
            f"📉 [DB Update] {real_name}({emp_id}): Score → {new_score}, "
            f"Repeat Offender: {is_repeat}, Status: {updates.get('status', current_status)}"
        )

    except Exception as e:
        print(f"❌ 自动化引擎出错: {e}")


# ==========================================
# 🌟 功能 8：抓拍与调度 (updated: stores confidence_score + monthly history)
# ==========================================
def log_detection(emp_id, violation_type, frame, confidence=0.0):
    """
    Logs a PPE violation to Firestore.

    confidence (float, 0–100): YOLO per-detection confidence percentage.

    Why store confidence:
        ISO/IEC 22989:2022 (AI Trustworthiness Terminology) recommends recording
        model confidence scores for AI system auditability and transparency.
        HR can use this value to assess detection reliability for each incident.

    Why write to safety_history/{YYYY-MM}:
        ISO 45001:2018 Clause 7.5 requires retaining documented OH&S information
        for a defined period. Monthly sub-collections partition data by month,
        supporting the 12-month retention policy and monthly performance evaluation
        per Clause 9.1.
    """
    global last_logged_time
    current_time = time.time()
    log_key = f"{emp_id}_{violation_type}"

    with log_lock:
        if log_key in last_logged_time and (current_time - last_logged_time[log_key] < 60):
            return
        last_logged_time[log_key] = current_time

    try:
        # 1. Upload screenshot to ImgBB
        _, buffer = cv2_imencode(frame)
        img_str = base64.b64encode(buffer)
        payload = {"key": IMGBB_API_KEY, "image": img_str}
        response = requests.post("https://api.imgbb.com/1/upload", payload, timeout=10)
        image_url = response.json()["data"]["url"]

        real_name = get_real_name(emp_id)

        # 2. Write to main 'detections' collection (with confidence_score)
        db.collection("detections").add({
            "id": emp_id,
            "name": real_name,
            "violation": violation_type,
            "timestamp": firestore.SERVER_TIMESTAMP,
            "image_url": image_url,
            "status": "active",
            "confidence_score": round(confidence, 1),
        })
        print(f"[FIREBASE] Logged {real_name}({emp_id}): {violation_type} (Conf: {confidence:.1f}%)")

        # 3. Write to monthly safety_history for 12-month long-term record (Feature 7)
        now = datetime.datetime.now(tz=datetime.timezone.utc)
        month_key = now.strftime("%Y-%m")   # e.g. "2026-05"
        db.collection("safety_history").document(month_key).collection("records").add({
            "id": emp_id,
            "name": real_name,
            "violation": violation_type,
            "timestamp": firestore.SERVER_TIMESTAMP,
            "image_url": image_url,
            "confidence_score": round(confidence, 1),
        })

        # 4. Trigger automation rules
        if emp_id != "Unknown":
            check_and_apply_rules(emp_id, violation_type, image_url)

    except Exception as e:
        with log_lock:
            last_logged_time.pop(log_key, None)
        print(f"❌ Upload or rule execution failed: {e}")


def cv2_imencode(frame):
    import cv2
    return cv2.imencode('.jpg', frame)


# ==========================================
# 🌟 功能 7：员工离职处理
# 参考依据:
#   马来西亚个人资料保护法令 2010 (PDPA 2010) — 雇主须依法保留员工就业期间的
#   纪律记录，以备合规审计及法律诉讼参考，即使员工已离职。
#   ISO 45001:2018 Clause 7.5.3 — retained documented information must remain
#   accessible after employment ends.
# ==========================================
def handle_employee_resign(emp_id):
    """
    Sets employment_status to 'Resigned' and freezes active monitoring.
    Historical detection records are PRESERVED (not deleted) per PDPA 2010
    and ISO 45001:2018 Clause 7.5.3.
    """
    try:
        query = db.collection('users').where('id', '==', emp_id).stream()
        user_doc = next(query, None)
        if not user_doc:
            print(f"⚠️ [RESIGN] Employee {emp_id} not found.")
            return False

        user_doc.reference.update({
            'employment_status': 'Resigned',
            'status': 'Inactive',
            'gold_badge': False,
            'is_repeat_offender': False,
            'resignation_date': firestore.SERVER_TIMESTAMP,
        })
        print(f"📋 [RESIGN] {emp_id} set to Resigned. Historical records preserved (PDPA 2010).")
        return True
    except Exception as e:
        print(f"❌ [RESIGN] Error: {e}")
        return False


def handle_employee_return(emp_id):
    """
    Re-activates a resigned employee with a fresh safety score of 100.
    Reference: ISO 45001:2018 Clause 7.2 (Competence) — upon re-employment,
    safety compliance must be re-evaluated from baseline. Score resets to 100
    to reflect the new employment period. Past archived records remain intact
    for HR reference per PDPA 2010.
    """
    try:
        query = db.collection('users').where('id', '==', emp_id).stream()
        user_doc = next(query, None)
        if not user_doc:
            print(f"⚠️ [RETURN] Employee {emp_id} not found.")
            return False

        user_doc.reference.update({
            'employment_status': 'Active',
            'status': 'Active',
            'current_score': 100,          # Fresh start per ISO 45001:2018 Clause 7.2
            'gold_badge': False,           # Must re-earn in new employment period
            'is_repeat_offender': False,   # Reset; past records remain in archive
            'last_violation_date': None,
            'return_date': firestore.SERVER_TIMESTAMP,
        })
        print(f"✅ [RETURN] {emp_id} re-activated with fresh score of 100.")
        return True
    except Exception as e:
        print(f"❌ [RETURN] Error: {e}")
        return False


# ==========================================
# 🌟 功能 7：归档超过 12 个月的旧检测记录
# 参考依据: ISO 45001:2018 Clause 7.5.3 — Retention and disposition.
# 保留 12 个月的三大理由:
#   1. Performance Evaluation Cycle: 12 个月 = 完整年度绩效周期
#   2. Behavioural Pattern Analysis: 短期数据无法区分偶发违规与行为模式
#   3. Storage Optimisation: 归档减少主数据库查询负担，提升系统可扩展性
# ==========================================
def archive_old_records():
    """
    Moves detections older than 12 months to 'detections_archive'.
    Reference: ISO 45001:2018 Clause 7.5.3.
    """
    try:
        twelve_months_ago = (
            datetime.datetime.now(tz=datetime.timezone.utc) - datetime.timedelta(days=365)
        )
        old_docs = list(
            db.collection('detections').where('timestamp', '<', twelve_months_ago).stream()
        )

        if not old_docs:
            print("🗄️ [ARCHIVE] No records older than 12 months found.")
            return 0

        archive_ref = db.collection('detections_archive')
        batch = db.batch()
        batch_ops = 0
        total_archived = 0

        for doc in old_docs:
            data = doc.to_dict()
            data['archived_at'] = datetime.datetime.now(tz=datetime.timezone.utc)
            batch.set(archive_ref.document(doc.id), data)   # copy to archive
            batch.delete(doc.reference)                      # remove from active
            batch_ops += 2
            total_archived += 1

            # Firestore batch limit = 500 operations; stay safe at 480
            if batch_ops >= 480:
                batch.commit()
                batch = db.batch()
                batch_ops = 0

        if batch_ops > 0:
            batch.commit()

        print(f"🗄️ [ARCHIVE] Archived {total_archived} detection records older than 12 months.")
        return total_archived

    except Exception as e:
        print(f"❌ [ARCHIVE] Error: {e}")
        return 0


# ==========================================
# 🌟 功能 10：月度安全报告生成器
# 参考依据: ISO 45001:2018 Clause 9.1 — Monitoring, measurement, analysis and
# performance evaluation. 月度报告为管理层评审 (Clause 9.3) 和持续改进 (Clause 10.3)
# 提供结构化的安全绩效数据。在每月重置前自动生成，确保重置前的数据不丢失。
# ==========================================
def generate_monthly_safety_report():
    """
    Aggregates the past 30 days and writes a summary to 'monthly_reports/{YYYY-MM}'.
    Reference: ISO 45001:2018 Clause 9.1.1 and Clause 9.3 (Management Review).
    """
    try:
        now_utc = datetime.datetime.now(tz=datetime.timezone.utc)
        thirty_days_ago = now_utc - datetime.timedelta(days=30)
        month_key = thirty_days_ago.strftime("%Y-%m")

        detections = list(
            db.collection('detections')
            .where('timestamp', '>=', thirty_days_ago)
            .where('timestamp', '<', now_utc)
            .stream()
        )

        total = len(detections)
        helmet_count = 0
        vest_count = 0
        user_stats = {}

        for doc in detections:
            d = doc.to_dict()
            if d.get('violation') == 'No Helmet':
                helmet_count += 1
            elif d.get('violation') == 'No Vest':
                vest_count += 1
            emp_id = d.get('id', 'Unknown')
            if emp_id and emp_id != 'Unknown':
                if emp_id not in user_stats:
                    user_stats[emp_id] = {'name': d.get('name', emp_id), 'count': 0}
                user_stats[emp_id]['count'] += 1

        all_users = list(db.collection('users').stream())
        suspended_count = sum(1 for u in all_users if u.to_dict().get('status') == 'Suspended')
        safe_worker_count = sum(
            1 for u in all_users if u.to_dict().get('safe_worker_status') == 'Safe Worker'
        )
        repeat_offender_count = sum(
            1 for u in all_users if u.to_dict().get('is_repeat_offender') is True
        )

        top_violator_id = None
        top_violator_name = None
        top_violator_count = 0
        if user_stats:
            top_id = max(user_stats, key=lambda k: user_stats[k]['count'])
            top_violator_id = top_id
            top_violator_name = user_stats[top_id]['name']
            top_violator_count = user_stats[top_id]['count']

        report_data = {
            'report_month': month_key,
            'generated_at': firestore.SERVER_TIMESTAMP,
            'total_violations': total,
            'helmet_violations': helmet_count,
            'vest_violations': vest_count,
            'total_employees': len(all_users),
            'suspended_count': suspended_count,
            'safe_worker_count': safe_worker_count,
            'repeat_offender_count': repeat_offender_count,
            'top_violator_id': top_violator_id,
            'top_violator_name': top_violator_name,
            'top_violator_count': top_violator_count,
        }

        db.collection('monthly_reports').document(month_key).set(report_data)
        print(
            f"📊 [MONTHLY REPORT] {month_key} saved — "
            f"{total} violations, {suspended_count} suspended, {safe_worker_count} safe workers."
        )
        return True

    except Exception as e:
        print(f"❌ [MONTHLY REPORT] Error: {e}")
        return False


# ==========================================
# 定时任务：每月重置与解封 (updated)
# ==========================================
def reset_all_users_monthly():
    """
    Monthly reset order (runs on 1st of each month):
      1. Generate monthly safety report BEFORE reset (captures full month data)
      2. Archive records older than 12 months
      3. Reset all scores to 100 + unsuspend employees
      4. Award Gold Badge to 30+-day violation-free employees
      5. Award +10 reward points to violation-free employees

    Why reset score to 100 monthly:
        ISO 45001:2018 Clause 10.2 (Corrective action) — employees who have taken
        corrective action should not be permanently penalised. A monthly recovery
        cycle provides a fair rehabilitation mechanism, aligning with Malaysian
        construction site safety management practices where demerit scores are
        reviewed on a monthly basis.
    """
    try:
        # Step 1: Generate report before any data changes
        generate_monthly_safety_report()

        # Step 2: Archive old records
        archive_old_records()

        # Step 3 + 4 + 5: Reset scores, award badges and points
        docs = list(db.collection('users').stream())
        batch = db.batch()
        count = 0
        now_utc = datetime.datetime.now(tz=datetime.timezone.utc)

        for doc in docs:
            user_data = doc.to_dict()
            real_name = user_data.get('name', doc.id)
            emp_id    = user_data.get('id', doc.id)

            update_data = {
                'current_score': 100,
                'status': 'Active',
                # Step 3a: Clear Repeat Offender flag first, then re-evaluate below.
                # This prevents the flag from being permanently stuck once earned.
                # The flag will be re-set immediately if the 90-day window still
                # qualifies the employee (violations from last quarter carry over).
                'is_repeat_offender': False,
            }

            # Re-evaluate Repeat Offender based on actual 90-day rolling window.
            # Running check_repeat_offender() now (after clearing the flag) ensures
            # the badge reflects current reality, not a stale state from months ago.
            is_still_repeat = check_repeat_offender(emp_id)
            if is_still_repeat:
                update_data['is_repeat_offender'] = True
                print(f"🔁 [REPEAT] {real_name} still qualifies as Repeat Offender after reset.")

            # Feature 2: Award Gold Badge if 30+ days violation-free
            # Reference: ISO 45001:2018 Clause 10.3
            check_and_award_gold_badge(doc.reference, user_data, real_name)

            # Feature 2: Award +10 reward points for violation-free month
            # Reference: ISO 45001:2018 Clause 10.3
            last_viol = user_data.get('last_violation_date')
            days_clean = None
            if last_viol and isinstance(last_viol, datetime.datetime):
                days_clean = (now_utc - last_viol).days
            elif not last_viol:
                days_clean = 999  # Never had a violation

            if days_clean is not None and days_clean >= 30:
                current_points = user_data.get('reward_points', 0)
                update_data['reward_points'] = current_points + 10
                print(f"🎁 [REWARD] {real_name} earned +10 reward points for violation-free month!")

            batch.update(doc.reference, update_data)
            count += 1

        if count > 0:
            batch.commit()
            print(f"🔄 [CRON JOB] Monthly reset complete: {count} employees reset to 100.")
        else:
            print("🔄 [CRON JOB] No employee records found.")

    except Exception as e:
        print(f"❌ [CRON JOB] Monthly reset failed: {e}")
