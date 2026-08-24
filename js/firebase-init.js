// Firebase setup — these web config values are public identifiers, not secrets.
// Data access is protected by Firestore security rules (firestore.rules).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBazFDbH1SYXl6GFNIs22A47W1nNj-HB7M",
  authDomain: "sixth-ward-app.firebaseapp.com",
  projectId: "sixth-ward-app",
  storageBucket: "sixth-ward-app.firebasestorage.app",
  messagingSenderId: "935229974691",
  appId: "1:935229974691:web:ce77fe734542e65e563716",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();

// The bishop's account. Firestore rules treat this email as bishop even before
// a role document exists, so the app can never lock itself out.
export const BISHOP_EMAIL = "jordanchri@gmail.com";
