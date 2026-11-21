# Storage, Claims and Stateful Data

Containers have writable layers that are tied to container lifetime. A Pod can be replaced on another node, so durable state needs a storage mechanism with a lifecycle and failure model that outlives an individual container. Kubernetes separates an application's request for storage from the implementation that supplies it through PersistentVolumes (PVs), PersistentVolumeClaims (PVCs), StorageClasses and CSI drivers.

## PVs, PVCs and StorageClasses

A PV represents provisioned storage in the cluster; a PVC is a namespaced request for capacity and access characteristics. A Pod references the claim, not a cloud disk identifier. This abstraction lets application manifests remain decoupled from provider-specific volumes, while an administrator or provisioner maps the request to an actual backend. A StorageClass defines parameters and a provisioner for dynamically creating PVs when claims arrive.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: uploads
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: standard
  resources:
    requests:
      storage: 20Gi
```

`standard` is an example name; the available StorageClasses and their properties are cluster-specific. Inspect them with `kubectl get storageclass`. A claim can remain Pending if no class exists, capacity cannot be provisioned, topology cannot be satisfied, or access modes do not match. Dynamic provisioning is performed by a CSI driver or other provisioner, not by the PVC object itself.

Access modes such as `ReadWriteOnce`, `ReadOnlyMany` and `ReadWriteMany` describe how a volume can be mounted; they are not universal file-locking guarantees. `ReadWriteOnce` commonly allows read-write mounting from one node, which may still permit more than one Pod on that node depending on backend and semantics. `ReadWriteOncePod` has stronger single-Pod semantics where supported. The storage backend, CSI driver, Kubernetes version and filesystem determine actual behavior. Do not infer database safety from an access mode alone.

A PV has a reclaim policy. `Delete` typically removes the backing storage when the claim is released, while `Retain` leaves it for an administrator to recover or clean up. Dynamic StorageClass reclaim defaults vary by class; inspect rather than assume. Deleting a PVC is potentially destructive. Protection finalizers can delay deletion while a volume is in use, but they are not a backup. Backups need application-consistent capture and a tested restore procedure.

## Mounts, lifecycle and topology

A Pod mounts a PVC into one or more containers using `volumeMounts`. A claim bound to zone-local storage can constrain a Pod to the volume's zone. `WaitForFirstConsumer` volume binding mode delays provisioning until the scheduler considers the Pod's placement, helping align storage with topology. This is especially important for stateful workloads spanning zones. A local PersistentVolume has stronger node affinity and does not survive the loss of its node without separate replication or backup.

A StatefulSet can create one PVC per ordinal via `volumeClaimTemplates`. Each Pod then keeps its claim when the Pod is recreated with the same identity. This is valuable for databases that expect stable member identity, but Kubernetes does not replicate the data or elect a primary. StatefulSet deletion also does not necessarily delete associated PVCs automatically. Plan how upgrades, scale-down and deletion treat each claim, and inspect PVC/PV state before cleanup.

Ephemeral volumes are useful when data is disposable or scoped to a Pod. `emptyDir` survives a container restart within the same Pod but not Pod removal; a memory-backed `emptyDir` consumes memory. Projected volumes can combine ConfigMaps, Secrets and service account data. `hostPath` exposes a node filesystem path and can create security, portability and scheduling problems; avoid it for ordinary application state.

## CSI and storage operations

Container Storage Interface (CSI) drivers implement provisioning, attachment, mount, expansion and snapshot operations for storage systems. The driver and cloud environment dictate which capabilities exist. Check driver version, supported volume modes, topology, snapshot support and resize behavior before adopting a manifest. Kubernetes object creation does not prove the volume is mounted correctly or that the filesystem has the expected semantics.

Useful checks include:

```bash
kubectl get pvc -n apps
kubectl describe pvc uploads -n apps
kubectl get pv
kubectl get pods -n apps -o wide
kubectl describe pod <pod-name> -n apps
```

Events identify pending binding, attach or mount errors. CSI controller and node plugin logs help when kubelet reports a mount failure. For an application-visible issue, also check file ownership and permissions: a mounted filesystem may not be writable by the container's UID. `fsGroup` can help for supported volumes, but its behavior and cost vary by driver and filesystem. Do not solve permission problems by running every container as root without understanding the mount's ownership model.

## Data safety and recovery

Persistent storage is not automatically highly available. A single volume can be durable against container restart and still be lost with a region, account or storage failure. A replicated database may keep copies across zones, but write consistency, quorum and failover are application concerns. Define RPO and RTO, encrypt data at rest and in transit as needed, test backup restoration, and ensure secrets and encryption keys are recoverable. Snapshots are useful but must be coordinated with the application's consistency requirements.

During a rollout, keep compatibility between old and new application versions if both may access the same data. Schema migrations should be sequenced so rollback is possible or explicitly irreversible. Scaling a StatefulSet down can detach a claim from the application while leaving data behind; scaling back up may reconnect it. Validate that the application's storage directory, file permissions and lock behavior work on the selected backend.

## Expansion, snapshots and access modes

Some StorageClasses and CSI drivers support PVC expansion. The workflow and filesystem resize behavior depend on the driver, volume type and whether the volume is mounted; consult the storage provider documentation and observe claim conditions rather than manually editing PV capacity. Shrinking a claim is not a general supported operation. Volume snapshots likewise require a compatible snapshot controller and CSI support, and the snapshot may capture only crash-consistent state unless the application is coordinated. A database backup tool may be necessary for application-level consistency.

Access modes describe a mount request, not a transaction or locking protocol. Two Pods mounting a shared filesystem can still corrupt data if the application is not designed for concurrent access. Conversely, a block volume that is single-node attachable may be exactly right for one database member. Match storage characteristics to the software's write and recovery model. Before changing a claim or class, verify the currently bound PV and underlying storage identifier, understand the provider's deletion behavior, and ensure a tested backup exists. Storage migrations should have a copy, verification and rollback plan; changing a YAML field does not move bytes safely by itself.

## Common mistakes

- Treating a PVC as a backup or assuming `Retain` means the application is recoverable.
- Assuming `ReadWriteMany` makes concurrent writes safe for a database.
- Deleting a claim to clear a stuck Pod without checking PV reclaim policy and data consequences.
- Using a zone-bound volume with a Pod affinity policy that only permits another zone.
- Expecting a StatefulSet to provide replication or safe database upgrades automatically.

## Production notes

Label storage classes by operational purpose, document reclaim behavior, and review the class name in every stateful workload. Alert on claim provisioning failures, capacity growth, volume attachment errors and storage latency. Protect restore tooling from the same failure domain as the primary data. For cluster upgrades, confirm CSI compatibility and test detach/attach recovery. Storage operations should be managed as data operations: verify the target claim and namespace before destructive actions, and never use deletion as a generic restart procedure.