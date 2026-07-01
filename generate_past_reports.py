"""
One-off script: generates monthly_reports documents for every month
that has detection records in Firestore.

Run once from the FYP folder:
    python generate_past_reports.py
"""

import datetime
import database_manager
from firebase_admin import firestore

db = database_manager.db

def generate_report_for_month(year: int, month: int):
    month_key = f"{year}-{month:02d}"
    start = datetime.datetime(year, month, 1, tzinfo=datetime.timezone.utc)
    # End = first day of next month
    if month == 12:
        end = datetime.datetime(year + 1, 1, 1, tzinfo=datetime.timezone.utc)
    else:
        end = datetime.datetime(year, month + 1, 1, tzinfo=datetime.timezone.utc)

    detections = list(
        db.collection('detections')
        .where('timestamp', '>=', start)
        .where('timestamp', '<', end)
        .stream()
    )

    if not detections:
        print(f"  [{month_key}] No detections found — skipped.")
        return

    total = len(detections)
    helmet_count = 0
    vest_count = 0
    user_stats = {}

    for doc in detections:
        d = doc.to_dict()
        v = d.get('violation', '')
        if v == 'No Helmet':
            helmet_count += 1
        elif v == 'No Vest':
            vest_count += 1
        emp_id = d.get('id', 'Unknown')
        if emp_id and emp_id != 'Unknown':
            if emp_id not in user_stats:
                user_stats[emp_id] = {'name': d.get('name', emp_id), 'count': 0}
            user_stats[emp_id]['count'] += 1

    all_users = list(db.collection('users').stream())
    suspended_count      = sum(1 for u in all_users if u.to_dict().get('status') == 'Suspended')
    safe_worker_count    = sum(1 for u in all_users if u.to_dict().get('safe_worker_status') == 'Safe Worker')
    repeat_offender_count = sum(1 for u in all_users if u.to_dict().get('is_repeat_offender') is True)

    top_violator_id    = None
    top_violator_name  = None
    top_violator_count = 0
    if user_stats:
        top_id = max(user_stats, key=lambda k: user_stats[k]['count'])
        top_violator_id    = top_id
        top_violator_name  = user_stats[top_id]['name']
        top_violator_count = user_stats[top_id]['count']

    report_data = {
        'report_month':          month_key,
        'generated_at':          firestore.SERVER_TIMESTAMP,
        'total_violations':      total,
        'helmet_violations':     helmet_count,
        'vest_violations':       vest_count,
        'total_employees':       len(all_users),
        'suspended_count':       suspended_count,
        'safe_worker_count':     safe_worker_count,
        'repeat_offender_count': repeat_offender_count,
        'top_violator_id':       top_violator_id,
        'top_violator_name':     top_violator_name,
        'top_violator_count':    top_violator_count,
    }

    db.collection('monthly_reports').document(month_key).set(report_data)
    print(f"  [{month_key}] Report saved — {total} violations, top: {top_violator_name} ({top_violator_count})")


def main():
    print("Scanning detections for months with data...")

    # Collect all distinct YYYY-MM values from detections
    all_docs = db.collection('detections').stream()
    months_found = set()
    for doc in all_docs:
        ts = doc.to_dict().get('timestamp')
        if ts and isinstance(ts, datetime.datetime):
            months_found.add((ts.year, ts.month))

    if not months_found:
        print("No detections found.")
        return

    print(f"Found data in {len(months_found)} month(s): "
          f"{sorted(f'{y}-{m:02d}' for y, m in months_found)}\n")

    for year, month in sorted(months_found):
        generate_report_for_month(year, month)

    print("\nDone. Refresh the Analytics page to see the reports.")


if __name__ == "__main__":
    main()
