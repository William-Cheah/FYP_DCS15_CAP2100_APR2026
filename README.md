# Sentinel-Eye — AI-Powered PPE Compliance Monitoring System

Final Year Project (FYP) | DCS15 CAP2100 APR2026

## Description
Sentinel-Eye is an AI-powered PPE (Personal Protective Equipment) 
compliance monitoring system for construction sites, using YOLOv8 
object detection and face recognition to automatically identify 
safety violations in real time.

## Tech Stack
- Python, Flask, YOLOv8, face_recognition, OpenCV
- Firebase Firestore, Firebase Authentication
- JavaScript (ES Modules), Chart.js, jsPDF

## Prerequisites
- Python 3.10
- NVIDIA GPU with CUDA installed
- XAMPP (to serve the frontend HTML files)
- Google Chrome browser

## Setup
1. Install dependencies:
   pip install -r requirements.txt

2. Install PyTorch with CUDA (match your GPU version):
   https://pytorch.org/get-started/locally/

3. Add your `firebase_key.json`:
   - Firebase Console → Project Settings → Service Accounts → Generate new private key
   - Place the file in the root FYP folder

4. Create a `.env` file in the root FYP folder:
   IMGBB_API_KEY=your_imgbb_api_key

5. Place your XAMPP folder at `C:\xampp\htdocs\FYP`

## Running the System
1. Start XAMPP Apache server
2. Run the backend: `python main.py`
3. Open browser: `http://localhost/FYP/html/login.html`

## First Time Use
1. Login with admin account
2. Go to Register Account to register employees (captures face photos automatically)
3. Switch to DETECTING mode on the Dashboard to start monitoring

## Notes
- `firebase_key.json` and `.env` are not included for security reasons
- `known_faces/` folder is empty — face photos are registered through the system
- `best.pt` is the trained YOLOv8 model for PPE detection
