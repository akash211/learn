# Configuration, Secrets and Environment Injection

Configuration determines how the same image behaves in development, staging and production. Kubernetes separates much configuration from the image through ConfigMaps, Secrets, environment variables and mounted files. This keeps artifacts reusable, but it also creates lifecycle questions: when does a changed value reach a running process, who can read it, and how is it rotated without an unsafe rollout?

## ConfigMaps

A ConfigMap stores non-confidential key/value data or text files. Pods can consume values as environment variables, command arguments, or a mounted volume. Keep the immutable application artifact separate from environment-specific endpoints and feature settings; avoid embedding cluster URLs and credentials in a Docker image. ConfigMaps are namespaced and can be referenced by name in a Pod template.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: api-settings
  namespace: apps
data:
  LOG_LEVEL: info
  app.yaml: |
    upstream:
      timeout: 3s
```

Environment injection can be explicit:

```yaml
env:
  - name: LOG_LEVEL
    valueFrom:
      configMapKeyRef:
        name: api-settings
        key: LOG_LEVEL
```

Alternatively, `envFrom` imports all keys with valid environment-variable names. Explicit references make the contract visible and avoid accidental collisions. For a file-based configuration, mount a ConfigMap key at a path the application reads. Mounted ConfigMap volumes are updated eventually when the object changes, subject to kubelet propagation and mount behavior; a process that reads a file only at startup still needs a restart or a reload signal. A ConfigMap consumed as an environment variable does not change inside an already running process when the ConfigMap changes.

## Secrets and threat model

A Secret is a Kubernetes object intended for confidential data, such as a password or TLS private key. Its `data` field uses base64 encoding, which is not encryption. Anyone with sufficient API permissions can retrieve the value. By default, do not treat the word Secret as a guarantee that data is encrypted at rest; configure encryption for the backing store if required, restrict RBAC, and understand provider behavior. Avoid printing secret values into logs, terminal history or CI output.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: db-auth
  namespace: apps
type: Opaque
stringData:
  username: app
  password: replace-through-a-secure-workflow
```

This example illustrates a schema, not a credential. In real delivery, do not commit live values in plaintext manifests. Use a secret manager integration, sealed/encrypted workflow or controlled deployment process. Secret values may be mounted as files or injected into a container environment. Environment values can be exposed through process inspection, crash reports or diagnostics, so mounted files or short-lived external credentials may be preferable when the application supports them.

A Secret referenced by a Pod must exist in the same namespace. If it is absent, the Pod may remain in a waiting state, and event output explains the failed reference. Access to Secrets should be narrower than general Pod read access: a user who can create a Pod in a namespace may often arrange for it to expose data from Secrets in that namespace. Namespace isolation alone is not sufficient for hostile tenants.

## Injection and lifecycle

`env`, `envFrom`, `configMapKeyRef` and `secretKeyRef` expose values at container creation. A ConfigMap or Secret mounted as a volume updates asynchronously, except for `subPath` mounts, which do not receive updates in the same manner. Applications need to watch/reload files or be restarted to use new values. A rollout annotation with a checksum is a common pattern used by chart or deployment tooling to trigger a new ReplicaSet when external configuration changes, but avoid adding an unstable timestamp that causes every apply to restart the workload.

A Deployment template can reference configuration as follows:

```yaml
spec:
  containers:
    - name: api
      image: nginx:1.27
      envFrom:
        - configMapRef:
            name: api-settings
      env:
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: db-auth
              key: password
```

The public nginx image makes the container reference concrete; the `DB_PASSWORD` injection illustrates Kubernetes mechanics and only matters to an application that reads that variable. In a real manifest, select your application's immutable image and a controlled secret source. Be cautious with `envFrom`: key names become environment names and can collide with image defaults or other sources. For values that can contain newlines or structured data, a mounted file can avoid shell quoting problems.

## Defaults, arguments and precedence

Kubernetes has several ways to set process behavior. Image `ENTRYPOINT` and `CMD` provide defaults; Pod `command` and `args` can override them. Environment variables are not automatically expanded in every YAML field. Kubernetes supports `$(VAR_NAME)` expansion in selected command and args fields, but this is not a shell and does not perform arbitrary shell substitution. If a shell is required, invoke one explicitly, while considering signal handling and injection risks. Prefer application-native config parsing to assembling complex shell commands.

A `valueFrom` reference avoids copying a secret into each Deployment manifest. Do not mistake it for dynamic secret lookup: when the container starts, Kubernetes resolves the referenced key to a value. For rotation, update the source and restart or reload the application according to its API. External secret controllers can sync from provider stores but add another controller, credentials path and failure mode; understand refresh intervals, deletion behavior and audit trail.

## Security and access

Use namespace-scoped Roles and RoleBindings that grant only the required verbs and resources. Avoid broad `get/list/watch secrets` permissions because those can reveal all secrets in a namespace. Protect control-plane access, audit secret reads where available, and use encryption at rest for etcd or provider-managed backing storage. At the application layer, rotate credentials, prefer short-lived tokens where supported, and make services tolerate rotation without taking down all replicas.

Kubernetes Secret data is not automatically masked in events, logs or rendered manifests. GitOps systems may store encrypted or reference-only data in source, but the cluster API still contains the resulting Secret. Restrict backups and snapshots too. Container security contexts and filesystem permissions matter for mounted Secret volumes; run as a non-root user when possible and avoid overly broad volume mounts.

## Common mistakes

- Assuming base64-encoded `Secret.data` is encrypted or safe to commit.
- Updating an environment-backed ConfigMap and expecting existing processes to observe the new value.
- Using `subPath` and assuming the projected file will refresh like a normal volume mount.
- Giving application developers unrestricted Secret listing because they need to deploy workloads.
- Putting production credentials in `kubectl create secret --from-literal` commands that land in shell history or process listings.

## Production notes

Version configuration when reproducibility and rollback matter; define who owns rotation and how to roll back a bad value. Distinguish harmless settings from changes that require a coordinated migration. Before restarting every replica, test that old and new credentials can overlap and that readiness remains meaningful. In incident response, inspect object names, Pod events and mount paths without copying values into tickets. Configuration is part of the application's release surface: validate it, review it, restrict it, and observe whether the running process actually loaded it.