import { expect, loadBackground, nextTick, preferencesTestSet } from './setup';

describe('external add-on request-path timeouts', () => {
  it('fails open when Containerise does not answer', async () => {
    const bg = await loadBackground({ preferences: preferencesTestSet[0] });
    const containerise = bg.tmp.management.addons.get('containerise@kinte.sh');
    expect(containerise).to.exist;

    const previousEnabled = containerise!.enabled;
    containerise!.enabled = true;
    bg.browser.runtime.sendMessage.callsFake((extensionId: string) => {
      if (extensionId === 'containerise@kinte.sh') {
        return new Promise(() => undefined);
      }
      return Promise.resolve(undefined);
    });

    try {
      const resultPromise = bg.tmp.request.externalAddonHasPrecedence({
        request: {
          requestId: 'containerise-timeout',
          tabId: 1,
          url: 'https://example.com/',
        } as any,
      });

      bg.clock.tick(500);
      await nextTick();

      expect(await resultPromise).to.equal(false);
    } finally {
      containerise!.enabled = previousEnabled;
    }
  });

  it('fails open when Multi-Account Containers does not answer', async () => {
    const bg = await loadBackground({ preferences: preferencesTestSet[0] });
    bg.browser.runtime.sendMessage.callsFake((extensionId: string) => {
      if (extensionId === '@testpilot-containers') {
        return new Promise(() => undefined);
      }
      return Promise.resolve(undefined);
    });

    const resultPromise = bg.tmp.mac.getAssignment('https://example.com/');
    bg.clock.tick(500);
    await nextTick();

    expect(await resultPromise).to.equal(undefined);
  });

  it('fails open when Tree Style Tab does not answer', async () => {
    const bg = await loadBackground({ preferences: preferencesTestSet[0] });
    bg.browser.runtime.sendMessage.callsFake((extensionId: string) => {
      if (extensionId === 'treestyletab@piro.sakura.ne.jp') {
        return new Promise(() => undefined);
      }
      return Promise.resolve(undefined);
    });

    const resultPromise = (bg.tmp.isolation as any).getTreeStyleTabItem(42);
    bg.clock.tick(500);
    await nextTick();

    expect(await resultPromise).to.equal(undefined);
  });
});
