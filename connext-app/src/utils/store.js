export const store = {
  get: (key) => {
    const raw = localStorage.getItem(`CF_NODE:${key}`)
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    // Handle partial matches so the following line works -.-
    // https://github.com/counterfactual/monorepo/blob/master/packages/node/src/store.ts#L54
    if (key.endsWith("channel") || key.endsWith("appInstanceIdToProposedAppInstance")) {
      const partialMatches = {}
      for (const k of Object.keys(localStorage)) {
        if (k.includes(`${key}/`)) {
          try {
            partialMatches[k.replace('CF_NODE:', '').replace(`${key}/`, '')] = JSON.parse(localStorage.getItem(k))
          } catch {
            partialMatches[k.replace('CF_NODE:', '').replace(`${key}/`, '')] = localStorage.getItem(k)
          }
        }
      }
      return partialMatches;
    }
    return raw;
  },
  set: (pairs, allowDelete) => {
    for (const pair of pairs) {
      localStorage.setItem(
        `CF_NODE:${pair.key}`,
        typeof pair.value === 'string' ? pair.value : JSON.stringify(pair.value),
      );
    }
  }
};
