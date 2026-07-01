// 1. Import Firebase core and Firestore from the CDN
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js";
import { getFirestore, collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyADjUxwb0RI1GnEszGF9U6c2q2AhM37gFU",
  authDomain: "fyp-sentinel-eye.firebaseapp.com",
  projectId: "fyp-sentinel-eye",
  storageBucket: "fyp-sentinel-eye.firebasestorage.app",
  messagingSenderId: "850393067962",
  appId: "1:850393067962:web:da732b54810071c1d7ad83",
  measurementId: "G-D6MDHJ5D0H"
};


// 3. Initialize Firebase and Firestore
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// export the db so other modules can use it
export { db };