export const api = new Proxy({} as TeamSpaceBridge['api'], {
  get: (_target, property: keyof TeamSpaceBridge['api']) => {
    return (...args: unknown[]) => {
      const method = window.teamSpace.api[property] as (...methodArgs: unknown[]) => unknown;
      if (typeof method !== 'function') {
        throw new Error(`Метод приложения ${String(property)} недоступен. Перезапустите приложение.`);
      }
      return method(...args);
    };
  }
});
