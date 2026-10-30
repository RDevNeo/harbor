package dev.harbor.app;

import android.app.Activity;
import android.credentials.Credential;
import android.credentials.CredentialManager;
import android.credentials.CredentialOption;
import android.credentials.GetCredentialException;
import android.credentials.GetCredentialRequest;
import android.credentials.GetCredentialResponse;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.OutcomeReceiver;

/** Android's own "choose an account" sheet (Credential Manager, Android 14+), asking Google
 *  Play services for a Google ID token for Harbor's Web client: no website, no redirect.
 *  Built on the framework API by hand (no AndroidX or googleid library in the app): the option
 *  carries the same type and Bundle keys Google's GetGoogleIdOption (googleid 1.1.0) does.
 *  Only loaded on Android 14+ (Account checks first). */
final class GooglePicker {
    static final String P = "com.google.android.libraries.identity.googleid.";
    static final String TYPE = P + "TYPE_GOOGLE_ID_TOKEN_CREDENTIAL";

    interface Result {
        /** The ID token Google signed for Harbor's Web client. */
        void token(String idToken);
        /** Not possible here (no Google account or provider, an error): use the browser. */
        void browser(String why);
        /** The person closed the sheet. */
        void canceled();
    }

    static void pick(Activity a, String webClientId, String nonce, Result r) {
        CredentialManager cm = a.getSystemService(CredentialManager.class);
        if (cm == null) { r.browser("no credential manager"); return; }
        Bundle b = new Bundle();
        b.putString(P + "BUNDLE_KEY_SERVER_CLIENT_ID", webClientId);
        b.putString(P + "BUNDLE_KEY_NONCE", nonce);
        // Every Google account on the phone, not only ones that used Harbor before: the sheet.
        b.putBoolean(P + "BUNDLE_KEY_FILTER_BY_AUTHORIZED_ACCOUNTS", false);
        b.putBoolean(P + "BUNDLE_KEY_AUTO_SELECT_ENABLED", false);
        b.putBoolean(P + "BUNDLE_KEY_REQUEST_VERIFIED_PHONE_NUMBER", false);
        b.putStringArrayList(P + "BUNDLE_KEY_ID_TOKEN_DEPOSITION_SCOPES", null);
        b.putString(P + "BUNDLE_KEY_LINKED_SERVICE_ID", null);
        b.putBoolean("androidx.credentials.BUNDLE_KEY_IS_AUTO_SELECT_ALLOWED", false);
        b.putInt("androidx.credentials.BUNDLE_KEY_TYPE_PRIORITY_VALUE", 2000);
        CredentialOption opt = new CredentialOption.Builder(TYPE, b, b).setIsSystemProviderRequired(true).build();
        Bundle meta = new Bundle();
        meta.putBoolean("androidx.credentials.BUNDLE_KEY_PREFER_IDENTITY_DOC_UI", false);
        meta.putBoolean("androidx.credentials.BUNDLE_KEY_PREFER_IMMEDIATELY_AVAILABLE_CREDENTIALS", false);
        GetCredentialRequest req = new GetCredentialRequest.Builder(meta).addCredentialOption(opt).build();
        try {
            cm.getCredential(a, req, new CancellationSignal(), a.getMainExecutor(), new OutcomeReceiver<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse res) {
                    Credential c = res.getCredential();
                    String token = c == null || !TYPE.equals(c.getType()) ? null : c.getData().getString(P + "BUNDLE_KEY_ID_TOKEN");
                    if (token == null || token.isEmpty()) r.browser("no ID token");
                    else r.token(token);
                }

                @Override
                public void onError(GetCredentialException e) {
                    if (GetCredentialException.TYPE_USER_CANCELED.equals(e.getType())) r.canceled();
                    else r.browser(e.getType() + ": " + e.getMessage());
                }
            });
        } catch (Exception | LinkageError e) {
            r.browser(e.toString());
        }
    }
}
