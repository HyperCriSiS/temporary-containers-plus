import { TemporaryContainers } from './tmp';
import { Debug } from '~/types';

// to have persistent listeners we need to register them early+sync
// and wait for tmp to fully initialize before handling events
export class EventListeners {
  private background: TemporaryContainers;
  private debug: Debug;
  private tmpInitializedPromiseResolvers: Array<{
    resolve: () => void;
    timeout: number;
  }> = [];
  private defaultTimeout = 30; // seconds
  private listeners: Array<{
    listener: (...listenerArgs: any[]) => any;
    api: any;
  }> = [];

  constructor(background: TemporaryContainers) {
    this.background = background;
    this.debug = background.debug;

    this.register();
  }

  register(): void {
    this.debug('[event-listeners] registering');

    browser.webRequest.onBeforeRequest.addListener(
      this.wrap(browser.webRequest.onBeforeRequest, this.background.request, 'webRequestOnBeforeRequest', {
        timeout: 5,
        failOpenWhileInitializing: true,
      }),
      { urls: ['<all_urls>'], types: ['main_frame'] },
      ['blocking']
    );
    browser.webRequest.onBeforeSendHeaders.addListener(
      this.wrap(browser.webRequest.onBeforeSendHeaders, this.background.cookies, 'maybeSetAndAddToHeader'),
      { urls: ['<all_urls>'], types: ['main_frame'] },
      ['blocking', 'requestHeaders']
    );
    browser.webRequest.onCompleted.addListener(
      this.wrap(browser.webRequest.onCompleted, this.background.statistics, 'collect'),
      {
        urls: ['<all_urls>'],
        types: ['script', 'font', 'image', 'imageset', 'stylesheet'],
      },
      ['responseHeaders']
    );
    browser.webRequest.onCompleted.addListener(this.wrap(browser.webRequest.onCompleted, this.background.request, 'cleanupCanceled'), {
      urls: ['<all_urls>'],
      types: ['main_frame'],
    });
    browser.webRequest.onErrorOccurred.addListener(
      this.wrap(browser.webRequest.onErrorOccurred, this.background.request, 'cleanupCanceled'),
      { urls: ['<all_urls>'], types: ['main_frame'] }
    );
    browser.browserAction.onClicked.addListener(this.wrap(browser.browserAction.onClicked, this.background.browseraction, 'onClicked'));
    browser.contextMenus.onClicked.addListener(this.wrap(browser.contextMenus.onClicked, this.background.contextmenu, 'onClicked'));
    browser.contextMenus.onShown.addListener(this.wrap(browser.contextMenus.onShown, this.background.contextmenu, 'onShown'));
    browser.windows.onFocusChanged.addListener(
      this.wrap(browser.windows.onFocusChanged, this.background.contextmenu, 'windowsOnFocusChanged')
    );
    browser.management.onDisabled.addListener(this.wrap(browser.management.onDisabled, this.background.management, 'disable'));
    browser.management.onUninstalled.addListener(this.wrap(browser.management.onUninstalled, this.background.management, 'disable'));
    browser.management.onEnabled.addListener(this.wrap(browser.management.onEnabled, this.background.management, 'enable'));
    browser.management.onInstalled.addListener(this.wrap(browser.management.onInstalled, this.background.management, 'enable'));
    browser.commands.onCommand.addListener(this.wrap(browser.commands.onCommand, this.background.commands, 'onCommand'));
    browser.tabs.onActivated.addListener(this.wrap(browser.tabs.onActivated, this.background.tabs, 'onActivated'));
    browser.tabs.onCreated.addListener(this.wrap(browser.tabs.onCreated, this.background.tabs, 'onCreated'));
    browser.tabs.onUpdated.addListener(this.wrap(browser.tabs.onUpdated, this.background.tabs, 'onUpdated'));
    browser.tabs.onRemoved.addListener(this.wrap(browser.tabs.onRemoved, this.background.tabs, 'onRemoved'));
    browser.runtime.onMessage.addListener(this.wrap(browser.runtime.onMessage, this.background.runtime, 'onMessage'));
    browser.runtime.onMessageExternal.addListener(
      this.wrap(browser.runtime.onMessageExternal, this.background.runtime, 'onMessageExternal')
    );
    browser.runtime.onStartup.addListener(this.wrap(browser.runtime.onStartup, this.background.runtime, 'onStartup'));

    this.registerPermissionedListener();
  }

  registerPermissionedListener(): void {
    browser.webNavigation?.onCommitted.addListener(this.wrap(browser.webNavigation?.onCommitted, this.background.scripts, 'maybeExecute'));
  }

  wrap(
    api: any,
    context: any,
    target: any,
    options: { timeout: number; failOpenWhileInitializing?: boolean } = { timeout: this.defaultTimeout }
  ): (...listenerArgs: any[]) => any {
    const tmpInitializedPromise = this.createTmpInitializedPromise(options);

    const listener = (...listenerArgs: any[]): any => {
      if (!this.background.initialized) {
        if (options.failOpenWhileInitializing) {
          // A blocking webRequest listener must never hold a navigation while
          // the extension is still restoring storage/tabs/add-on state.
          // Returning synchronously also avoids Gecko suspending the channel
          // for an unresolved Promise during cold start / Android resume.
          this.debug(`[event-listeners] ${target} received before initialization; allowing request`);
          return;
        }

        return tmpInitializedPromise
          .then(() => context[target].call(context, ...listenerArgs))
          .catch(error => {
            this.debug(`[event-listeners] call to ${target} timed out after ${options.timeout}s`);
            throw error;
          });
      }

      return context[target].call(context, ...listenerArgs);
    };

    this.listeners.push({ listener, api });
    return listener;
  }

  createTmpInitializedPromise(options: { timeout: number }): Promise<void> {
    const abortController = new AbortController();
    const timeout = window.setTimeout(() => {
      abortController.abort();
    }, options.timeout * 1000);

    return new Promise((resolve, reject) => {
      this.tmpInitializedPromiseResolvers.push({ resolve, timeout });

      abortController.signal.addEventListener('abort', () => {
        reject('Timed out while waiting for Add-on to initialize');
      });
    });
  }

  public tmpInitialized = (): void => {
    this.tmpInitializedPromiseResolvers.map(resolver => {
      resolver.resolve();
      window.clearTimeout(resolver.timeout);
    });
  };

  remove(): void {
    this.listeners.map(listener => {
      listener.api.removeListener(listener.listener);
    });
  }
}
