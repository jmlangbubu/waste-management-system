# Staging classifier build preparation

Prepared 2026-11-22. Application source: commit
`de3ea29169cb46ec37cb02468be927fb77bdfa48` in
`jmlangbubu/waste-management-system`. The five existing classifier files are
unchanged. This document authorizes no publication, deployment or traffic change.

## Locked build inputs

- Build context: this directory only, not the backend repository root.
- Platform: `linux/amd64` (Cloud Run target).
- Runtime: official `node:22.23.5-bookworm-slim`, pinned in `Dockerfile` to the
  platform manifest `sha256:47725aca53d3295ec2d3be8f62726599b3033cc262edc2c7e429909b3ac599fc`.
- The registry index was
  `sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`;
  both response-body hashes were checked against `Docker-Content-Digest`.
- Node `22.23.5` bundles npm `10.9.9`. The classifier-local npm lockfile v3
  matches the unchanged `package.json`; no backend lockfile was copied.
- Direct dependency: Express `4.22.3`, within the existing `^4.21.0` range.
  The lock contains 68 registry packages, with exact versions and SHA-512
  integrity values. Selected transitive versions: body-parser `1.20.9`,
  path-to-regexp `0.1.13`, qs `6.16.2`, send `0.19.2`, serve-static `1.16.3`.
- Installation is `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`.
  No locked dependency declares an install script. The image runs as `node`
  using the existing `node server.js` entry point and honors runtime `PORT`.

The `.dockerignore` permits only the package manifest, lockfile, four JavaScript
runtime files and Docker build metadata. Explicit `COPY` instructions also
restrict the application image contents. Local node_modules, Git internals,
`.env` files, other JSON files, credentials and this document are excluded.
There are no credential build arguments, secret files or Gemini keys/tokens in
the image. Supply approved staging secrets only at runtime.

These inputs fix the runtime and dependency graph. They do not promise identical
image bytes across different builders or build metadata. Record and deploy the
verified digest of the actual application image, not a mutable image tag or the
base-image digest.

## Build locally

Run from this directory:

```sh
docker build --platform=linux/amd64 --provenance=false -t wmo-a9-classifier:de3ea291-off .
```

This performs a local image build only. Registry publication requires separate
owner authorization. Do not pass an env file, credentials, keys or tokens to the
build, and do not add secret files to the context allowlist.

## Completed local verification

- The actual Linux/amd64 image built successfully. Local image manifest:
  `sha256:4f987ef0b180797727ffd165da862b0f653f1966e83792f251ead76d1b688c4f`.
  This image has not been published to a registry.
- Actual runtime: Node `22.23.5`, npm `10.9.9`, Express `4.22.3`; non-root UID
  1000; PID 1 is `node server.js`. The installed tree passes offline `npm ls`.
- Runtime smoke checks: 14/14 PASS. They cover exact application/lock hashes,
  image file inventory, absent credential environment, `/health`, rejected
  invalid `/classify-waste` requests, safe failure without a Gemini key, and
  discovery/assessment default OFF.
- Mocked contract checks: 3/3 PASS. The real Express route returns the existing
  success envelope using a synthetic HTTPS transport; proposal OFF preserves
  the original single-call request body; discovery/assessment remain disabled.
  The test child also starts successfully with runtime `PORT=8091`.
- All runtime checks used a read-only task container with Docker networking
  disabled (`--network=none`), no host ports, no secret mounts and no real keys.
  The HTTPS mock uses an unusable synthetic key in the test process only; it is
  absent from the image. Actual external inference calls: zero.
- The first immediate smoke request failed with `ECONNREFUSED` before readiness
  polling was present. Its raw failure record is retained. The temporary harness
  added an eight-second readiness-poll deadline, with an outer 45-second process
  timeout. The retry passed; captured startup logs show the listener on port
  8080 without startup errors. No application-source correction was made.
- Actual Docker context export, using the unchanged `.dockerignore`, admitted
  exactly eight allowlisted files. Synthetic `.env`, credential JSON, nested
  private-key JSON, Git internals, local node_modules, backup files and unrelated
  backend files were excluded. This document was excluded too. No real secret
  was used in that test. Docker build checks completed with no warnings.
- All 347 pre-existing tracked files remain byte-identical, including all five
  classifier files and the proposal suite's source/test inputs. The established
  379/379 proposal result is preserved; that broad suite was not rerun. The new
  dependency/runtime boundary was verified by the focused real-image checks.
- Only four metadata files were added: this document, `Dockerfile`,
  `.dockerignore` and `package-lock.json`. The Git index remains empty, refs and
  other worktrees are unchanged, seven stashes and both Android checkouts are
  preserved, and Draft PRs #165-#169 and #171 retain their draft/head/base state.
  Pre-existing local containers are preserved; task verification containers were
  removed. Original evidence, including its 121 hashes, is unchanged.

Raw build, smoke, mock-contract, context-export, source-hash and preservation
records are retained outside the build context for owner review. These local
results do not attest live GCP IAM, Secret Manager, model access or rollback
availability. No Git publication, cloud deployment, database action or feature
activation was performed.

## Recorded hashes

SHA-256 of the existing source and prepared build inputs:

| File | SHA-256 |
| --- | --- |
| server.js | `8d7dd2440d2375500fa8b784d22aebfb5897c74e19f85c74791fadf43d4ca314` |
| cropRecognition.js | `bf61cf28f2bbf865d990a1b2af296fb26e54620efe7f631cc4a66355268a7bdb` |
| wholeImageRecognition.js | `4545afd5ff116ec6c16d68c5ad42f7262e8e95b8259b9edc91f3f336e0536d69` |
| wasteItemAssessment.js | `41c845434abbe7ece3789aa5a0d8eeda97de76c43ebc8752fccd0ee42f3b4ab3` |
| package.json | `219f2655ce50aaaf3c0108fe9dca0ffef493fb9bae093495704297f9d2b3b669` |
| package-lock.json | `1008f74b366445898ef263e865a9a613de71f03908bdc0d78c8b568eb914404b` |
| Dockerfile | `5c7804b110cab69b280ee08a6ca0ac5bb9d38cda58b10bf01f697fb2db910c2c` |
| .dockerignore | `85718b4aec4c3470abbf6328f542ab60de81eb5460633b8de93f4ab4b48f22a2` |

## Future staging deployment gates

Target only project `gen-lang-client-0282087033`, service
`gemini-waste-classifier-staging`, region `us-central1`. Preserve production
`gemini-waste-classifier` and the existing staging revision
`gemini-waste-classifier-staging-00016-jix`.

Before deployment authorization:

1. Verify live staging IAM authentication, the existing runtime identity, and
   Invoker access for
   `wmo-render-staging-caller@gen-lang-client-0282087033.iam.gserviceaccount.com`.
   Do not alter IAM or generate a service-account key.
2. Record the complete current traffic allocation, old revision/image digest,
   safe configuration values, variable names and Secret Manager resource/version
   references. Do not print secret payloads. Confirm the rollback revision and
   its image still exist. Do not assume its allocation is 100% without checking.
   Check existing command/argument overrides against `node server.js`; any
   required override correction must be included in the owner's reviewed plan.
3. Verify staging project access to `gemini-2.5-flash`. Offline mocked tests do
   not establish access, quota or live model behavior. Preserve the existing
   model-selection and eligibility code. Google's current notice schedules
   automatic rerouting of this model on December 1, 2026; review compatibility
   before any future A9 activation. Do not silently substitute another model.
4. Approve the image repository, immutable application-image digest and unused
   revision suffix/test tag. Preserve existing approved staging secret references
   and runtime/service settings; no new proposal token is needed while OFF.

Initial revision settings:

```text
CLASSIFY_OBJECT_PROPOSALS_ENABLED=false
WHOLE_IMAGE_DISCOVERY_ENABLED=false
WASTE_ITEM_ASSESSMENT_AI_ENABLED=false
```

The Railway backend must remain `WMO_CLASSIFY_OBJECT_PROPOSALS_ENABLED=false`.
No Railway changes are part of this build preparation or deployment template.

## Zero-traffic deployment template -- NOT EXECUTED

Only after the gates above and explicit owner authorization, with the three
`APPROVED_` variables filled from reviewed values:

```sh
gcloud run deploy gemini-waste-classifier-staging \
  --project=gen-lang-client-0282087033 \
  --region=us-central1 \
  --image="$APPROVED_STAGING_IMAGE_DIGEST" \
  --revision-suffix="$APPROVED_UNUSED_REVISION_SUFFIX" \
  --tag="$APPROVED_TEST_TAG" \
  --no-traffic \
  --update-env-vars=CLASSIFY_OBJECT_PROPOSALS_ENABLED=false,WHOLE_IMAGE_DISCOVERY_ENABLED=false,WASTE_ITEM_ASSESSMENT_AI_ENABLED=false
```

Use an image reference ending in `@sha256:<verified application manifest digest>`.
Do not use source deployment, IAM-changing options, secret replacement options,
or options that clear the existing environment. Preserve the existing service
identity, ingress and remaining settings; compare them after the operation.

Verify the new revision is Ready with 0% normal service traffic and that every
old revision retains its captured allocation. A tagged URL deliberately routes
direct test requests to the new revision despite its 0% allocation. Preserve
IAM; authenticate those tests as the existing staging caller, with the service
origin as the ID-token audience rather than the tagged URL.

After separate live-test authorization, check unauthenticated rejection,
authenticated `/health`, missing-image rejection, and one approved synthetic
`/classify-waste` request. Confirm the existing response envelope and no proposal
sidecar while OFF. Discovery and assessment must remain disabled. Live inference
can consume provider quota; local offline checks do not authorize it.

Stop for owner review before any traffic migration. If zero-traffic validation
fails, leave the old traffic map untouched. If a later authorized migration
needs rollback, restore the exact recorded revision allocation:

```sh
gcloud run services update-traffic gemini-waste-classifier-staging \
  --project=gen-lang-client-0282087033 \
  --region=us-central1 \
  --to-revisions="$APPROVED_ORIGINAL_TRAFFIC"
```

Use `gemini-waste-classifier-staging-00016-jix=100` only if that is the captured,
approved original allocation. Verify traffic and authenticated health afterward.
Do not delete the rollback revision/image or change IAM, secrets or feature flags
as a rollback shortcut.

References: [Cloud Run deploy flags](https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy),
[traffic and rollbacks](https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration),
[Gemini model deprecations](https://aistudio.google.com/docs/deprecations).
