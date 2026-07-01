import threading
import time
import datetime
import secrets
import hashlib

from flask import Flask, Response, request, jsonify
import firebase_admin
from firebase_admin import auth as firebase_auth

import ai_engine
from ai_engine import SHARED_STATE
from email_manager import send_warning_email, send_otp_email, send_training_email
import database_manager

app = Flask(__name__)
SYSTEM_SECRET_TOKEN = "Sentinel-Eye-Super-Secret-2026"

def generate_frames():
    """Pull JPEG-encoded frames from the AI engine and yield as MJPEG stream."""
    while True:
        with SHARED_STATE["global_frame_lock"]:
            frame = SHARED_STATE["global_frame"]

        if frame is not None:
            # global_frame is already JPEG bytes (encoded by ai_engine.py)
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')
            time.sleep(0.033)   # ~30 fps cap
        else:
            time.sleep(0.05)

@app.route('/stream')
def video_feed():
    resp = Response(generate_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')
    # Allow any origin so the stream works from phones / other devices on the LAN
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    resp.headers['X-Accel-Buffering'] = 'no'   # stops nginx/proxies from buffering the stream
    return resp

@app.route('/set_mode', methods=['POST'])
def set_mode():
    auth_header = request.headers.get('Authorization')
    if auth_header != f"Bearer {SYSTEM_SECRET_TOKEN}":
        return jsonify({"status": "error", "message": "Unauthorized"}), 401

    data = request.json
    new_mode = data.get('mode')
    
    if new_mode in ["DETECTING", "PAUSED", "STANDBY"]:
        # Update the AI engine's operating mode
        SHARED_STATE["current_mode"] = new_mode
        print(f"🌐 [Web Command] Mode switched to: {new_mode}")
        return jsonify({"status": "success", "mode": new_mode})
    
    return jsonify({"status": "error", "message": "Invalid mode"}), 400

@app.after_request
def add_header(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type,Authorization'
    response.headers['Access-Control-Allow-Methods'] = 'GET,PUT,POST,DELETE,OPTIONS'
    return response

# ==========================================
# 🌟 时间管家 (Background Scheduler)
# ==========================================
def get_last_reset_month():
    """
    Read the last completed monthly reset month from Firestore ('system/monthly_reset').
    Returns a string like "2026-05", or None if never recorded.
    This persists across Flask restarts so the scheduler knows what already ran.
    """
    try:
        doc = database_manager.db.collection('system').document('monthly_reset').get()
        if doc.exists:
            return doc.to_dict().get('last_run_month')
    except Exception as e:
        print(f"⚠️ [Scheduler] Could not read last reset month: {e}")
    return None

def save_last_reset_month(month_key):
    """Persist the completed reset month to Firestore so restarts don't re-run it."""
    try:
        database_manager.db.collection('system').document('monthly_reset').set(
            {'last_run_month': month_key}, merge=True
        )
    except Exception as e:
        print(f"⚠️ [Scheduler] Could not save last reset month: {e}")

def monthly_reset_loop():
    """
    Runs reset_all_users_monthly() exactly ONCE per calendar month.

    Two trigger paths:
    1. CATCH-UP on startup: if Flask was offline on the 1st and the current
       month's reset has not yet run, execute it immediately on startup.
       This fixes the bug where the reset was permanently missed if the server
       was not running at exactly 00:00–00:05 on the 1st.
    2. SCHEDULED at midnight: on the 1st of each month between 00:00–00:05,
       run the reset as normal.

    The last completed month is persisted to Firestore ('system/monthly_reset')
    so the guard survives Flask restarts — preventing accidental double-runs.

    Reference: ISO 45001:2018 Clause 9.1; CIDB Malaysia Safety Guidelines 2022.
    """
    print("⏳ [Scheduler] Monthly reset scheduler online — checking date every 5 minutes...")

    now = datetime.datetime.now()
    month_key = now.strftime("%Y-%m")

    # Load the last completed reset month from Firestore (survives restarts)
    last_run_month = get_last_reset_month()
    print(f"📋 [Scheduler] Last recorded reset month: {last_run_month or 'None (first run)'}")

    # ── Catch-up: run immediately if this month's reset was missed ──────────
    # Condition: we are past the 1st of the current month AND this month hasn't
    # been reset yet. This handles the case where Flask was offline on the 1st.
    if last_run_month != month_key:
        print(f"🔔 [Scheduler] Catch-up reset needed for {month_key} — running now...")
        database_manager.reset_all_users_monthly()
        last_run_month = month_key
        save_last_reset_month(month_key)
        print(f"✅ [Scheduler] Catch-up reset complete for {month_key}.")

    while True:
        now = datetime.datetime.now()
        month_key = now.strftime("%Y-%m")

        # Fire on the 1st of the month, within the first 5 minutes of midnight,
        # but only if we haven't already run this month.
        if (now.day == 1 and now.hour == 0 and now.minute < 5
                and month_key != last_run_month):
            print(f"🔔 [Scheduler] 1st of month detected — running monthly reset for {month_key}...")
            database_manager.reset_all_users_monthly()
            last_run_month = month_key
            save_last_reset_month(month_key)
            print(f"✅ [Scheduler] Monthly reset complete for {month_key}.")
            time.sleep(600)   # sleep 10 min so we don't re-check inside the same window

        # Poll every 5 minutes — negligible CPU, precise enough for a 5-min window
        time.sleep(300)

def run_flask():
    app.run(debug=False, host='0.0.0.0', port=5050, use_reloader=False)

# ==========================================
# 🌟 接收网页发来的邮件请求
# 注意：methods 里必须加上 'OPTIONS'，用来放行浏览器的探路请求！
# ==========================================
@app.route('/api/send_training_email', methods=['POST', 'OPTIONS'])
def api_send_training_email():
    """
    Admin-triggered training referral email.
    Body: { "email": "...", "name": "...", "pattern": "...",
            "violation_count": 5, "admin_name": "..." }
    Reference: ISO 45001:2018 Clause 7.2 — Competence & Training
    """
    if request.method == 'OPTIONS':
        return jsonify({"status": "success"}), 200
    try:
        data            = request.json or {}
        employee_email  = (data.get('email') or '').strip()
        employee_name   = (data.get('name') or 'Employee').strip()
        pattern         = (data.get('pattern') or 'Repeated violations').strip()
        violation_count = int(data.get('violation_count') or 0)
        admin_name      = (data.get('admin_name') or 'Safety Officer').strip()

        if not employee_email:
            return jsonify({"status": "error", "message": "Employee email is required."}), 400

        ok = send_training_email(employee_email, employee_name, pattern, violation_count, admin_name)
        if ok:
            return jsonify({"status": "success", "message": f"Training referral sent to {employee_email}."})
        return jsonify({"status": "error", "message": "Failed to send email. Check SMTP settings."}), 500
    except Exception as e:
        print(f"❌ [/api/send_training_email] {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/send_warning_email', methods=['POST', 'OPTIONS'])
def api_send_warning():
    # 1. 遇到 OPTIONS 探路请求，直接放行
    if request.method == 'OPTIONS':
        return jsonify({"status": "success"}), 200

    # 2. 处理真正的 POST 邮件请求
    try:
        data = request.json
        employee_email = data.get('email')
        pdf_base64 = data.get('pdf_data')

        if not employee_email or not pdf_base64:
            return jsonify({"status": "error", "message": "Missing email or PDF data"}), 400

        print(f"\n🌐 [Web Request] 收到前端请求，准备发送警告信至: {employee_email}")
        
        # 呼叫 email_manager 干活
        success = send_warning_email(employee_email, pdf_base64)
        
        if success:
            return jsonify({"status": "success", "message": "Email sent successfully"})
        else:
            return jsonify({"status": "error", "message": "Failed to send email"}), 500
            
    except Exception as e:
        print(f"❌ [API Error] 处理邮件请求时出错: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

# ── OTP helpers ───────────────────────────────────────────────────────────────
# Security design:
#   - OTP is a 6-digit code generated by secrets.randbelow() (CSPRNG, NIST SP 800-90A)
#   - Stored in Firestore collection `otp_tokens`, document key = SHA-256(email)
#     (hashing avoids exposing the email as a plain Firestore document ID)
#   - 5-minute expiry enforced server-side (NIST SP 800-63B §5.1.3)
#   - Maximum 3 verification attempts before the token is invalidated
#     (OWASP Authentication Cheat Sheet — brute-force protection)
#   - Token is deleted immediately after successful verification (single-use)
#
# Reference: NIST SP 800-63B §5.1.3 — OTP Authenticators
#            OWASP Authentication Cheat Sheet (2023)
#            OWASP Forgot Password Cheat Sheet (2023)

OTP_EXPIRY_SECONDS = 300   # 5 minutes
OTP_MAX_ATTEMPTS   = 3

def _otp_doc_key(email: str) -> str:
    """Use SHA-256 of the email as the Firestore document ID."""
    return hashlib.sha256(email.lower().strip().encode()).hexdigest()[:32]

def _generate_and_store_otp(email: str, purpose: str) -> str:
    """
    Generate a cryptographically secure 6-digit OTP, store it in Firestore,
    and return the plain-text code for emailing.
    """
    code = f"{secrets.randbelow(1_000_000):06d}"   # 000000–999999
    doc_key = _otp_doc_key(email)
    database_manager.db.collection('otp_tokens').document(doc_key).set({
        'email':      email.lower().strip(),
        'code':       code,
        'purpose':    purpose,
        'expires_at': datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=OTP_EXPIRY_SECONDS),
        'attempts':   0,
        'used':       False,
    })
    print(f"🔐 [OTP] Generated {purpose} OTP for {email}, expires in {OTP_EXPIRY_SECONDS}s")
    return code

def _verify_otp(email: str, code: str, purpose: str) -> tuple[bool, str]:
    """
    Verify an OTP code.  Returns (success, error_message).
    On success the token is deleted (single-use).
    """
    doc_key = _otp_doc_key(email)
    ref  = database_manager.db.collection('otp_tokens').document(doc_key)
    snap = ref.get()
    if not snap.exists:
        return False, "No OTP found. Please request a new code."

    data = snap.to_dict()
    if data.get('used'):
        return False, "This OTP has already been used. Please request a new code."
    if data.get('purpose') != purpose:
        return False, "Invalid OTP purpose."
    if data.get('attempts', 0) >= OTP_MAX_ATTEMPTS:
        ref.delete()
        return False, "Too many incorrect attempts. Please request a new code."

    # Check expiry
    expires_at = data.get('expires_at')
    if expires_at and datetime.datetime.now(datetime.timezone.utc) > expires_at:
        ref.delete()
        return False, "OTP expired. Please request a new code."

    if data.get('code') != code.strip():
        ref.update({'attempts': data.get('attempts', 0) + 1})
        remaining = OTP_MAX_ATTEMPTS - data.get('attempts', 0) - 1
        return False, f"Incorrect code. {remaining} attempt(s) remaining."

    # ✅ Valid — delete the token immediately (single-use)
    ref.delete()
    return True, "OK"


# ── /api/send_otp ──────────────────────────────────────────────────────────────
@app.route('/api/send_otp', methods=['POST', 'OPTIONS'])
def api_send_otp():
    """
    Generate and email an OTP.
    Body: { "email": "...", "purpose": "mfa" | "reset" }
    """
    if request.method == 'OPTIONS':
        return jsonify({"status": "success"}), 200
    try:
        data    = request.json or {}
        email   = (data.get('email') or '').strip().lower()
        purpose = data.get('purpose', 'mfa')

        if not email:
            return jsonify({"status": "error", "message": "Email is required."}), 400
        if purpose not in ('mfa', 'reset'):
            return jsonify({"status": "error", "message": "Invalid purpose."}), 400

        # Fast ping used by the frontend to check if the backend is reachable.
        # Return immediately — no OTP generated, no email sent.
        if email == '__ping__':
            return jsonify({"status": "success", "message": "pong"})

        # For password reset, verify the email exists in Firebase Auth first
        # (OWASP Forgot Password Cheat Sheet — don't reveal whether email exists)
        if purpose == 'reset':
            try:
                firebase_auth.get_user_by_email(email)
            except firebase_auth.UserNotFoundError:
                # Return success anyway to prevent email enumeration
                print(f"⚠️  [OTP] Reset requested for unknown email: {email}")
                return jsonify({"status": "success",
                                "message": "If that email exists, a code has been sent."})

        code = _generate_and_store_otp(email, purpose)

        # Send the email in a background thread so Flask responds immediately.
        # The OTP is already persisted in Firestore — the client can show the
        # code-entry form right away while the email is delivered in the background.
        def _send():
            ok = send_otp_email(email, code, purpose)
            if not ok:
                print(f"⚠️  [OTP] Email delivery failed for {email} (purpose={purpose})")
        threading.Thread(target=_send, daemon=True).start()

        return jsonify({"status": "success",
                        "message": "OTP sent. Check your email."})
    except Exception as e:
        print(f"❌ [/api/send_otp] {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


# ── /api/verify_otp ────────────────────────────────────────────────────────────
@app.route('/api/verify_otp', methods=['POST', 'OPTIONS'])
def api_verify_otp():
    """
    Verify an OTP (used for MFA step — just checks the code, no password change).
    Body: { "email": "...", "code": "123456", "purpose": "mfa" }
    """
    if request.method == 'OPTIONS':
        return jsonify({"status": "success"}), 200
    try:
        data    = request.json or {}
        email   = (data.get('email') or '').strip().lower()
        code    = (data.get('code') or '').strip()
        purpose = data.get('purpose', 'mfa')

        ok, msg = _verify_otp(email, code, purpose)
        if ok:
            return jsonify({"status": "success"})
        return jsonify({"status": "error", "message": msg}), 400
    except Exception as e:
        print(f"❌ [/api/verify_otp] {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


# ── /api/reset_password ────────────────────────────────────────────────────────
@app.route('/api/reset_password', methods=['POST', 'OPTIONS'])
def api_reset_password():
    """
    Verify OTP then update the user's password via Firebase Admin SDK.

    Password requirements enforced here mirror the client-side checks
    (defence-in-depth — OWASP Authentication Cheat Sheet):
      - Minimum 8 characters (NIST SP 800-63B)
      - At least one uppercase letter
      - At least one lowercase letter
      - At least one digit
      - At least one special character

    Firebase Auth stores passwords as scrypt hashes (memory-hard KDF),
    satisfying NIST SP 800-132 password hashing requirements.

    Body: { "email": "...", "code": "123456", "new_password": "..." }
    """
    if request.method == 'OPTIONS':
        return jsonify({"status": "success"}), 200
    try:
        data         = request.json or {}
        email        = (data.get('email') or '').strip().lower()
        code         = (data.get('code') or '').strip()
        new_password = data.get('new_password', '')

        if not email or not code or not new_password:
            return jsonify({"status": "error", "message": "Email, code, and new password are required."}), 400

        # Server-side password policy (NIST SP 800-63B)
        import re
        if len(new_password) < 8:
            return jsonify({"status": "error", "message": "Password must be at least 8 characters."}), 400
        if not re.search(r'[A-Z]', new_password):
            return jsonify({"status": "error", "message": "Password must contain at least one uppercase letter."}), 400
        if not re.search(r'[a-z]', new_password):
            return jsonify({"status": "error", "message": "Password must contain at least one lowercase letter."}), 400
        if not re.search(r'\d', new_password):
            return jsonify({"status": "error", "message": "Password must contain at least one number."}), 400
        if not re.search(r'[@$!%*?&_#\-]', new_password):
            return jsonify({"status": "error", "message": "Password must contain at least one special character (@$!%*?&_#-)."}), 400

        # Verify OTP first
        ok, msg = _verify_otp(email, code, 'reset')
        if not ok:
            return jsonify({"status": "error", "message": msg}), 400

        # Update password via Firebase Admin SDK
        user = firebase_auth.get_user_by_email(email)
        firebase_auth.update_user(user.uid, password=new_password)
        print(f"✅ [Reset] Password updated for {email}")
        return jsonify({"status": "success", "message": "Password updated successfully."})

    except firebase_auth.UserNotFoundError:
        return jsonify({"status": "error", "message": "No account found for that email."}), 404
    except Exception as e:
        print(f"❌ [/api/reset_password] {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


if __name__ == "__main__":
    print("\n=======================================")
    print("🔥 Sentinel-Eye System Starting Up")
    print("=======================================\n")
    
    # 1. Start Flask gateway (handles API + stream)
    flask_thread = threading.Thread(target=run_flask, daemon=True)
    flask_thread.start()

    # 2. Start monthly reset scheduler (background thread)
    scheduler_thread = threading.Thread(target=monthly_reset_loop, daemon=True)
    scheduler_thread.start()

    time.sleep(2)

    # 3. Start AI engine (camera + detection loop)
    ai_engine.run_safety_violation()