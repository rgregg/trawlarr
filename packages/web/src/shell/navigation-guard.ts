/** A modal and its page can both be dirty; closing one must not unprotect the other. */
export const createNavigationGuard = () => {
  const pending = new Set<symbol>();
  return {
    register: (): (() => void) => {
      const token = Symbol('unsaved changes');
      pending.add(token);
      return () => {
        pending.delete(token);
      };
    },
    confirm: (ask: () => boolean): boolean => pending.size === 0 || ask(),
  };
};
