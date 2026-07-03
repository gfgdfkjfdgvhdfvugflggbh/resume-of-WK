(function () {
  const SDK_VERSION = '12.15.0';
  const REFRESH_TOKEN_KEY = 'sunny-firebase-refresh-token';
  let auth = null;
  let authSdk = null;
  let initialization = null;
  let mode = 'sdk';
  let initialized = false;

  async function initialize(config, options = {}) {
    if (initialized) return true;
    if (initialization) return initialization;
    if (!config?.apiKey || !config?.authDomain || !config?.projectId || !config?.appId) return false;

    if (options.proxy && /^https?:$/.test(location.protocol)) {
      mode = 'proxy';
      initialized = true;
      return true;
    }

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
      initialized = true;
      return true;
    })().catch(error => {
      initialization = null;
      throw error;
    });

    return initialization;
  }

  function authError(code) {
    const mapping = {
      INVALID_EMAIL: 'auth/invalid-email',
      EMAIL_EXISTS: 'auth/email-already-in-use',
      WEAK_PASSWORD: 'auth/weak-password',
      INVALID_PASSWORD: 'auth/invalid-credential',
      INVALID_LOGIN_CREDENTIALS: 'auth/invalid-credential',
      EMAIL_NOT_FOUND: 'auth/invalid-credential',
      USER_DISABLED: 'auth/user-disabled',
      OPERATION_NOT_ALLOWED: 'auth/operation-not-allowed',
      TOO_MANY_ATTEMPTS_TRY_LATER: 'auth/too-many-requests',
      AUTH_UPSTREAM_TIMEOUT: 'auth/upstream-timeout',
      INVALID_REFRESH_TOKEN: 'auth/invalid-refresh-token',
      TOKEN_EXPIRED: 'auth/invalid-refresh-token',
      USER_NOT_FOUND: 'auth/invalid-refresh-token'
    };
    const error = new Error(mapping[code] || 'auth/network-request-failed');
    error.code = mapping[code] || 'auth/network-request-failed';
    return error;
  }

  async function proxyRequest(body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    let response;
    try {
      response = await fetch('/api/auth-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (_) {
      throw authError('AUTH_UPSTREAM_TIMEOUT');
    } finally {
      clearTimeout(timeout);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw authError(String(data.error || 'FIREBASE_AUTH_FAILED').split(' : ')[0]);
    return data;
  }

  function proxyUserResult(payload) {
    const user = payload.user || payload;
    if (user.refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, user.refreshToken);
    return {
      uid: user.uid,
      email: user.email || '',
      displayName: user.displayName || '',
      idToken: user.idToken,
      serverSession: payload.session || null
    };
  }

  async function sdkUserResult(user) {
    return {
      uid: user.uid,
      email: user.email || '',
      displayName: user.displayName || '',
      idToken: await user.getIdToken(true)
    };
  }

  async function signUpWithEmail(email, password) {
    if (!initialized) throw new Error('FIREBASE_NOT_INITIALIZED');
    if (mode === 'proxy') return proxyUserResult(await proxyRequest({ action: 'signup', email, password }));
    const credential = await authSdk.createUserWithEmailAndPassword(auth, email, password);
    return sdkUserResult(credential.user);
  }

  async function signInWithEmail(email, password) {
    if (!initialized) throw new Error('FIREBASE_NOT_INITIALIZED');
    if (mode === 'proxy') return proxyUserResult(await proxyRequest({ action: 'signin', email, password }));
    const credential = await authSdk.signInWithEmailAndPassword(auth, email, password);
    return sdkUserResult(credential.user);
  }

  async function sendPasswordReset(email) {
    if (!initialized) throw new Error('FIREBASE_NOT_INITIALIZED');
    if (mode === 'proxy') {
      await proxyRequest({ action: 'reset', email });
      return;
    }
    await authSdk.sendPasswordResetEmail(auth, email);
  }

  async function getCurrentUser() {
    if (!initialized) return null;
    if (mode === 'proxy') {
      const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY) || '';
      if (!refreshToken) return null;
      try {
        return proxyUserResult(await proxyRequest({ action: 'refresh', refresh_token: refreshToken }));
      } catch (error) {
        if (error.code === 'auth/invalid-refresh-token') localStorage.removeItem(REFRESH_TOKEN_KEY);
        throw error;
      }
    }
    await auth.authStateReady();
    return auth.currentUser ? sdkUserResult(auth.currentUser) : null;
  }

  async function logout() {
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    if (mode === 'sdk' && auth && authSdk) await authSdk.signOut(auth);
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
