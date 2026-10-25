package dev.harbor.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.UserNotAuthenticatedException;

import java.io.IOException;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** The third factor: a Keystore key that signs only after the user unlocked this phone (its
 *  fingerprint, face or screen lock) within the last few minutes. Each PC pins its public key
 *  at pairing and wants its signature when a session starts (android/PROTOCOL.md). Opening the
 *  app soon after unlocking the phone asks nothing; otherwise this screen asks once.
 *  Also the (invisible) activity that shows the prompt. */
public class Presence extends Activity {
    static final String ALIAS = "harbor-presence";
    /** How long an unlock lets the key sign. */
    static final int VALID_S = 300;

    // ---- the key ----

    private static KeyStore ks() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        return ks;
    }

    static boolean secureLock() {
        KeyguardManager km = Ui.app == null ? null : Ui.app.getSystemService(KeyguardManager.class);
        return km != null && km.isDeviceSecure();
    }

    /** The key's public half (SubjectPublicKeyInfo DER), made the first time. */
    static synchronized byte[] publicKey() throws IOException {
        try {
            KeyStore ks = ks();
            if (!ks.containsAlias(ALIAS)) make();
            return ks.getCertificate(ALIAS).getPublicKey().getEncoded();
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException("This phone's key store can't make Harbor's sign-in key: " + e.getMessage(), e);
        }
    }

    private static void make() throws Exception {
        if (!secureLock())
            throw new IOException("Set a screen lock on this phone first (Settings › Security: PIN, pattern, password or fingerprint). Harbor needs it as the third factor to reach your PC.");
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true);
        if (Build.VERSION.SDK_INT >= 30)
            b.setUserAuthenticationParameters(VALID_S, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL);
        else
            setValidity(b);
        KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
        g.initialize(b.build());
        g.generateKeyPair();
    }

    @SuppressWarnings("deprecation")
    private static void setValidity(KeyGenParameterSpec.Builder b) { b.setUserAuthenticationValidityDurationSeconds(VALID_S); }

    /** The key was invalidated (the screen lock was removed): every pairing needs it again. */
    static synchronized void forget() {
        try { ks().deleteEntry(ALIAS); } catch (Exception ignored) { }
    }

    private static Signature signer() throws Exception {
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initSign((PrivateKey) ks().getKey(ALIAS, null));
        return s;
    }

    /** Signs msg; asks for the unlock first when the key can't sign now. Not on the UI thread. */
    static byte[] sign(byte[] msg, String why) throws IOException {
        for (int i = 0; ; i++) {
            try {
                Signature s = signer();
                s.update(msg);
                return s.sign();
            } catch (UserNotAuthenticatedException e) {
                if (i > 0) throw new IOException("This phone wasn't unlocked: Harbor can't sign in to the PC.");
                ask(why);
            } catch (KeyPermanentlyInvalidatedException e) {
                forget();
                throw new IOException("This phone's screen lock changed, so Harbor's sign-in key is gone. Pair the phone again.");
            } catch (Exception e) {
                throw new IOException("Harbor's sign-in key isn't working: " + e.getMessage(), e);
            }
        }
    }

    /** Asks for the unlock now unless the key can already sign. Not on the UI thread. */
    static void ready(String why) throws IOException {
        try {
            signer();
        } catch (UserNotAuthenticatedException e) {
            ask(why);
        } catch (KeyPermanentlyInvalidatedException e) {
            forget();
            throw new IOException("This phone's screen lock changed, so Harbor's sign-in key is gone. Pair the phone again.");
        } catch (Exception e) {
            throw new IOException("Harbor's sign-in key isn't working: " + e.getMessage(), e);
        }
    }

    // ---- the prompt ----

    private static CountDownLatch waiting;
    private static volatile boolean ok;
    private static volatile String reason;

    private static void ask(String why) throws IOException {
        CountDownLatch l;
        synchronized (Presence.class) {
            if (waiting == null || waiting.getCount() == 0) {
                // Only while Harbor is in front (a prompt out of nowhere would be a trap to tap).
                if (Base.resumed <= 0) throw new IOException("Open Harbor to sign in to the PC again.");
                waiting = new CountDownLatch(1);
                ok = false;
                reason = why;
                Ui.app.startActivity(new Intent(Ui.app, Presence.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION));
            }
            l = waiting;
        }
        try {
            if (!l.await(3, TimeUnit.MINUTES)) throw new IOException("No unlock: Harbor can't sign in to the PC.");
        } catch (InterruptedException e) {
            throw new IOException("Interrupted");
        }
        if (!ok) throw new IOException("Not unlocked: Harbor can't sign in to the PC.");
    }

    private static void done(boolean yes) {
        ok = yes;
        synchronized (Presence.class) { if (waiting != null) waiting.countDown(); }
    }

    private static final int CONFIRM = 1;
    private boolean finished;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        String why = reason == null ? "Sign in to your PC" : reason;
        if (Build.VERSION.SDK_INT >= 29) {
            BiometricPrompt.Builder pb = new BiometricPrompt.Builder(this).setTitle("Harbor").setSubtitle(why)
                    .setDescription("Your PC asks for this phone's unlock as the third factor.");
            if (Build.VERSION.SDK_INT >= 30) pb.setAllowedAuthenticators(android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG
                    | android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL);
            else allowCredential(pb);
            pb.build().authenticate(new CancellationSignal(), getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult r) { end(true); }
                @Override public void onAuthenticationError(int code, CharSequence msg) { end(false); }
            });
        } else {
            KeyguardManager km = getSystemService(KeyguardManager.class);
            @SuppressWarnings("deprecation")
            Intent i = km == null ? null : km.createConfirmDeviceCredentialIntent("Harbor", why);
            if (i == null) { end(false); return; }
            startActivityForResult(i, CONFIRM);
        }
    }

    @SuppressWarnings("deprecation")
    private static void allowCredential(BiometricPrompt.Builder pb) { pb.setDeviceCredentialAllowed(true); }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == CONFIRM) end(res == RESULT_OK);
    }

    private void end(boolean yes) {
        if (finished) return;
        finished = true;
        done(yes);
        finish();
        overridePendingTransition(0, 0);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (!finished) done(false);
    }

}
