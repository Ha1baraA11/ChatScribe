# Chrome Web Store release from GitHub Actions

The `.github/workflows/publish-chrome-store.yml` workflow builds the Chrome extension, packages the contents of `dist/`, uploads the ZIP to the existing Chrome Web Store item with API v2, and submits it for review.

The workflow is started manually from the `main` branch in GitHub Actions. The `chrome-web-store` GitHub Environment is the approval gate: configure at least one required reviewer there so the package is built before approval is requested and the upload happens only after approval.

The default `staged` mode submits the update for review and leaves it staged for a separate publish action after approval. Choose `automatic` only if you want the item to publish automatically when the review passes.

The publish request blocks on Chrome Web Store validation warnings. Resolve any reported warnings before rerunning the workflow.

## One-time setup

1. In Google Cloud, enable the Chrome Web Store API and create a service account.
2. In the Chrome Web Store Developer Dashboard, add that service account under the publisher account's **Account** settings. The service account must be authorized for the publisher that owns the existing ChatScribe listing.
3. Configure Workload Identity Federation so this GitHub repository can impersonate that service account. Map these claims:

   ```text
   google.subject=assertion.sub
   attribute.repository=assertion.repository
   attribute.ref=assertion.ref
   attribute.workflow_ref=assertion.workflow_ref
   attribute.environment=assertion.environment
   ```

   Set the provider condition to:

   ```text
   assertion.repository == 'Ha1baraA11/ChatScribe' &&
   assertion.ref == 'refs/heads/main' &&
   assertion.workflow_ref == 'Ha1baraA11/ChatScribe/.github/workflows/publish-chrome-store.yml@refs/heads/main' &&
   assertion.environment == 'chrome-web-store'
   ```

   Grant the matching GitHub repository principal `roles/iam.workloadIdentityUser` on the service account. Do not create a service-account JSON key for this workflow.
4. In GitHub repository **Settings → Environments**, create `chrome-web-store` and add required reviewers.
5. Add these repository variables in **Settings → Secrets and variables → Actions → Variables**:

   | Variable | Value |
   | --- | --- |
   | `GCP_PROJECT_ID` | Google Cloud project ID |
   | `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full Workload Identity Provider resource name |
   | `GCP_SERVICE_ACCOUNT` | Service account email added to the Chrome Web Store publisher |
   | `CWS_PUBLISHER_ID` | Publisher ID from the Chrome Web Store Developer Dashboard |
   | `CWS_EXTENSION_ID` | Existing ChatScribe Chrome Web Store item ID |

No OAuth refresh token or service-account key is stored in GitHub. The workflow requests a short-lived access token for the Chrome Web Store API.

## Each release

1. Update `manifest.chrome.json` to a version higher than the currently uploaded store version. Keep `manifest.firefox.json` aligned with the Chrome manifest version.
2. Merge the change to `main`. The release workflow checks that the existing **CI** workflow succeeded for the exact commit before it builds the package.
3. In **Actions → Submit Chrome Web Store review**, choose **Run workflow**, select `main`, and choose the publish mode.
4. Approve the `chrome-web-store` environment deployment when GitHub requests approval.
5. Check the workflow's API status readback. In `staged` mode, publish the approved staged version from the Developer Dashboard when you are ready.

The first item creation and store-listing/privacy declarations remain in the Developer Dashboard. This workflow updates and submits the package for an existing item.

Before submitting a build that adds Claude support, update the Developer Dashboard's privacy and data-use declarations to cover optional access to `claude.ai` and local processing of Claude conversation content. Changing the manifest and repository privacy policy does not update the dashboard declarations.
