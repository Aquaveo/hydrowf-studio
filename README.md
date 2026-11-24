# hydrowf-studio

A Tethys app for building pipelines from registered tools and running them on hydrowf. The studio is
only a client. It keeps no state and runs nothing. Pipelines run where the backend runs them: Argo now,
an HPC adapter later.

```
browser ── studio page (plain JS) ──► studio api/ (Tethys, as the logged-in user)
                                         ├─► hydrowf-registry   tools, data, publish a pipeline
                                         └─► hydrowf-ogc /ogc   describe, run, jobs, steps, results
                                                └─► Argo (or HPC): runs every step of the pipeline
```

- **Steps and links.** A pipeline is a hydrowf-core `Pipeline`. Each node is a step: one tool lego at a
  pinned version. A link passes a step's file or directory output to a later step's input.
- **Step inputs.** Each step input is set to one of:
  - a constant;
  - an input asked when the pipeline runs;
  - a registered data lego;
  - a link.
- **Publish and run.** Publish stores the pipeline in hydrowf-registry as the user's own (owner
  visibility). /ogc then offers it to that user alone, as `<id>@<version>`, within a minute. Run starts
  it as one job.
- **Drafts.** Drafts live in the browser (localStorage). Export and Import move them between browsers as
  JSON. Import also opens a published pipeline's JSON.

## Settings

| Setting | Default | What it is |
|---|---|---|
| `ogc_url` | `http://localhost:8000/ogc` | hydrowf-ogc's `/ogc` |
| `registry_url` | `http://localhost:8002` | hydrowf-registry (8001 is /ogc's step-key vendor port) |
| `poll_seconds` | `10` | How often the page reads a running job's steps |

Every call to the two services carries the user's Keycloak access token. Over an `http://` URL that token
crosses the network unencrypted. Use `https://`, or keep the services on a private cluster network.

## Login: Keycloak through social-auth

The user's token comes from the portal's social login (`social_django`), so the portal needs the Keycloak
backend. In `portal_config.yml`:

```yaml
settings:
  AUTHENTICATION_BACKENDS: [social_core.backends.keycloak.KeycloakOAuth2]
  OAUTH_CONFIG:
    SOCIAL_AUTH_KEYCLOAK_KEY: hydrowf-studio                      # the confidential client's id
    SOCIAL_AUTH_KEYCLOAK_SECRET: <the client's secret>
    SOCIAL_AUTH_KEYCLOAK_PUBLIC_KEY: <the realm's public key>
    SOCIAL_AUTH_KEYCLOAK_AUTHORIZATION_URL: https://<keycloak>/realms/hydrowf/protocol/openid-connect/auth
    SOCIAL_AUTH_KEYCLOAK_ACCESS_TOKEN_URL: https://<keycloak>/realms/hydrowf/protocol/openid-connect/token
    SOCIAL_AUTH_KEYCLOAK_ID_KEY: sub                               # the default ("username") isn't in the token
    SOCIAL_AUTH_KEYCLOAK_EXTRA_DATA: [[refresh_token, refresh_token], [expires_in, expires]]   # to refresh
```

In Keycloak, give the `hydrowf-studio` client audience mappers for `hydrowf-studio` (social-auth checks
`aud` against its client id) and `hydrowf-api` (/ogc and the registry check `aud` against it).

- **Refresh-token rotation.** Keep the realm's "Revoke Refresh Token" off. Two studio requests near a
  token's expiry can both refresh with the same refresh token. With rotation on, the second refresh
  would log the user out.
- **Error reports.** The token-holding locals are marked as sensitive, so Django's error reports leave
  them out. The HTTP library's own frames still hold the header, so don't run a portal with
  `DEBUG=True` where real tokens are used.

## Develop

Install the app into a Tethys portal, then build the page. The bundle goes to
`tethysapp/hydrowf_studio/public/frontend/`, which git ignores, so build before `tethys install` or packaging.

```
tethys install -d
npm install
npm run build          # or: npm run watch
tethys manage start
```

## Test

```
uv run --python 3.12 --no-project --with pytest --with requests --with social-auth-core python -m pytest -q
npm test               # node --test frontend/test/*.test.js
flake8 --max-line-length 120 tethysapp/hydrowf_studio tests
```

The Python tests run without a portal:
- `service.py`, `ogc.py` and `registry.py` against fake services over real HTTP;
- `api.py` and `tokens.refreshed` on their own.

`controllers.py` and `tokens.token_for` are the Tethys glue around them. The JavaScript tests cover the
pipeline model, the step form's logic and the API client.
