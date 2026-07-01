import smtplib
from email.message import EmailMessage
import base64

SMTP_FROM  = 'cheahweiliang32@gmail.com'
SMTP_PASS  = 'fcvzymovgiivzbti'
SMTP_HOST  = 'smtp.gmail.com'
SMTP_PORT  = 465

def _smtp_connect():
    """Return an authenticated SMTP_SSL connection."""
    smtp = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT)
    smtp.login(SMTP_FROM, SMTP_PASS)
    return smtp

def send_otp_email(target_email: str, otp_code: str, purpose: str = 'mfa') -> bool:
    """
    Send a 6-digit OTP email for MFA login verification or password reset.

    Security standards applied:
    - NIST SP 800-63B §5.1.3  — OTP authenticators: 6+ digits, time-limited (≤5 min)
    - OWASP Authentication Cheat Sheet — OTPs must expire and be single-use
    - OWASP Forgot Password Cheat Sheet — reset tokens must be sent to verified email only

    The OTP itself is generated server-side (in main.py) using secrets.randbelow(),
    which is cryptographically secure (CSPRNG), meeting NIST SP 800-90A requirements.
    """
    purpose_label = 'Multi-Factor Authentication' if purpose == 'mfa' else 'Password Reset'
    try:
        msg = EmailMessage()
        msg['Subject'] = f'🔐 Sentinel-Eye — Your {purpose_label} Code'
        msg['From']    = SMTP_FROM
        msg['To']      = target_email
        msg.set_content(
            f"Hello,\n\n"
            f"Your Sentinel-Eye {purpose_label} verification code is:\n\n"
            f"    {otp_code}\n\n"
            f"This code is valid for 5 minutes only.\n"
            f"Do NOT share this code with anyone.\n\n"
            f"If you did not request this code, your account may be at risk.\n"
            f"Please contact your system administrator immediately.\n\n"
            f"(Reference: NIST SP 800-63B §5.1.3 — Time-based OTP authenticators)\n\n"
            f"Regards,\nSentinel-Eye Security System"
        )
        with _smtp_connect() as smtp:
            smtp.send_message(msg)
        print(f"📧 [OTP Email] Sent {purpose_label} code to {target_email}")
        return True
    except Exception as e:
        print(f"❌ [OTP Email] Failed to send OTP to {target_email}: {e}")
        return False


def send_warning_email(employee_email, pdf_base64):
    """Send a PDF warning letter attachment to the employee."""
    try:
        msg = EmailMessage()
        msg['Subject'] = '⚠️ Official Warning Letter (Sentinel-Eye)'
        msg['From']    = SMTP_FROM
        msg['To']      = employee_email
        msg.set_content(
            "Hello,\n\nAttached is the automated warning letter regarding your recent "
            "safety violations detected by the Sentinel-Eye system. Please review it "
            "immediately and report to the site manager.\n\nRegards,\nSentinel-Eye Automated System"
        )
        pdf_bytes = base64.b64decode(pdf_base64.split(',')[1])
        msg.add_attachment(pdf_bytes, maintype='application', subtype='pdf', filename='Warning_Letter.pdf')
        with _smtp_connect() as smtp:
            smtp.send_message(msg)
        print(f"📧 [Email System] Sent PDF warning letter to {employee_email}")
        return True
    except Exception as e:
        print(f"❌ [Email System] Failed to send PDF email: {e}")
        return False


def send_training_email(employee_email: str, employee_name: str,
                        pattern: str, violation_count: int, admin_name: str = 'Safety Officer') -> bool:
    """
    Send a mandatory safety training referral email to an employee.
    Triggered manually by an admin from the Analytics & Reports page.

    Reference: ISO 45001:2018 Clause 7.2 — Competence & Training
    """
    try:
        msg = EmailMessage()
        msg['Subject'] = '📋 Sentinel-Eye — Mandatory Safety Training Referral'
        msg['From']    = SMTP_FROM
        msg['To']      = employee_email
        msg.set_content(
            f"Dear {employee_name},\n\n"
            f"This is an official notification from the Sentinel-Eye Safety Management System.\n\n"
            f"Our system has identified that you require mandatory safety training based on your "
            f"recent PPE compliance history:\n\n"
            f"   Violation Pattern : {pattern}\n"
            f"   Total Violations  : {violation_count} (last 12 months)\n\n"
            f"You are required to attend a Safety Awareness Training session as follows:\n\n"
            f"   Venue   : Training Room, Block A Level 2\n"
            f"   Contact : Safety Officer — Ext. 1023\n\n"
            f"Please report to the HR department to confirm your training session date.\n"
            f"Failure to attend may result in further disciplinary action.\n\n"
            f"This referral was issued by: {admin_name}\n\n"
            f"(Reference: ISO 45001:2018 Clause 7.2 — Competence & Training)\n\n"
            f"Regards,\nSentinel-Eye Safety Management System"
        )
        with _smtp_connect() as smtp:
            smtp.send_message(msg)
        print(f"📧 [Training Email] Sent training referral to {employee_email} ({employee_name})")
        return True
    except Exception as e:
        print(f"❌ [Training Email] Failed to send to {employee_email}: {e}")
        return False


def send_plain_email(target_email, subject, body_text):
    """Send a plain-text notification email (used by the AI violation engine)."""
    try:
        msg = EmailMessage()
        msg['Subject'] = subject
        msg['From']    = SMTP_FROM
        msg['To']      = target_email
        msg.set_content(body_text + "\n\nRegards,\nSentinel-Eye Automated System")
        with _smtp_connect() as smtp:
            smtp.send_message(msg)
        print(f"📧 [Auto-Email] Sent notification to {target_email}")
        return True
    except Exception as e:
        print(f"❌ [Auto-Email] Failed to send plain email: {e}")
        return False