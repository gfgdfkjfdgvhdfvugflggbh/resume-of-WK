(function () {
  const SDK_VERSION = '12.15.0';
  let auth = null;
  let authSdk = null;
  let initialization = null;

  async function initialize(config) {
    if (auth) return true;
    if (initialization) return initialization;
    if (!config?.apiKey || !config?.authDomain || !config?.projectId || !config?.appId) return false;

    initialization = (async () => {
      const [appSdk, loadedAuthSdk] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-auth.js`)
      ]);
      const firebaseApp = appSdk.initializeApp(config);
      authSdk = loadedAuthSdk;
      auth = authSdk.getAuth(firebaseApp);
      auth.languageCode = 'zh-CN';
      await authSdk.setPersistence(auth, authSdk.browserLocalPersistence);
      return true;
    })().catch(error => {
      initialization = null;
      throw error;
    });

    return initialization;
  }

  async function userResult(user) {
    return {
      uid: user.uid,
      email: user.email || '',
      displayName: user.displayName || '',
      idToken: await user.getIdToken(true)
    };
  }

  async function signUpWithEmail(email, password) {
    if (!auth || !authSdk) throw new Error('FIREBASE_NOT_INITIALIZED');
    const credential = await authSdk.createUserWithEmailAndPassword(auth, email, password);
    return userResult(credential.user);
  }

  async function signInWithEmail(email, password) {
    if (!auth || !authSdk) throw new Error('FIREBASE_NOT_INITIALIZED');
    const credential = await authSdk.signInWithEmailAndPassword(auth, email, password);
    return userResult(credential.user);
  }

  async function sendPasswordReset(email) {
    if (!auth || !authSdk) throw new Error('FIREBASE_NOT_INITIALIZED');
    await authSdk.sendPasswordResetEmail(auth, email);
  }

  async function getCurrentUser() {
    if (!auth || !authSdk) return null;
    await auth.authStateReady();
    return auth.currentUser ? userResult(auth.currentUser) : null;
  }

  async function logout() {
    if (auth && authSdk) await authSdk.signOut(auth);
  }

  window.firebaseAuthClient = {
    initialize,
    signUpWithEmail,
    signInWithEmail,
    sendPasswordReset,
    getCurrentUser,
    resetRecaptcha() {},
    logout
  };
})();
