/**
 * What the REST layer needs from remote-node connection management: whether
 * a node is currently connected, telling a connected node to re-pull its
 * config, and forcing a node off (a revoke must not leave a node's live
 * connection standing).
 *
 * Interface only in this task — Task 8 extends it (in this same file) with
 * whatever the daemon<->node channel needs beyond these three calls, and
 * Task 9 gives the daemon a real implementation. Until then, `ApiContext`
 * carries {@link createNoopNodeHub}, so every remote node reports offline
 * and every push/disconnect is a no-op: correct, because no real connection
 * exists yet to be online, pushed to, or dropped.
 */
export interface NodeHub {
  isOnline(nodeId: string): boolean;
  pushConfig(nodeId: string): void;
  disconnect(nodeId: string, reason: string): void;
}

/** The only implementation until Task 9 wires the real one into the daemon. */
export const createNoopNodeHub = (): NodeHub => ({
  isOnline: () => false,
  pushConfig: () => {},
  disconnect: () => {},
});
