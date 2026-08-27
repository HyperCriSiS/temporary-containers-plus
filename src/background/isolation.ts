import { TemporaryContainers } from './tmp';
import { Container } from './container';
import { MultiAccountContainers } from './mac';
import { Management } from './management';
import { MouseClick } from './mouseclick';
import { Request } from './request';
import { BrowserAction } from './browseraction';
import { PageAction } from './pageaction';
import { Storage } from './storage';
import { Utils } from './utils';
import { PreferencesSchema, IsolationAction, Tab, MacAssignment, Debug, WebRequestOnBeforeRequestDetails } from '~/types';

export class Isolation {
  private background: TemporaryContainers;
  private debug: Debug;
  private pref!: PreferencesSchema;
  private container!: Container;
  private request!: Request;
  private mouseclick!: MouseClick;
  private mac!: MultiAccountContainers;
  private management!: Management;
  private utils!: Utils;
  private browseraction!: BrowserAction;
  private pageaction!: PageAction;
  private storage!: Storage;
  private reactivateInterval: number;
  private readonly treeStyleTabMessageTimeoutMs = 500;

  constructor(background: TemporaryContainers) {
    this.background = background;
    this.debug = background.debug;
    this.reactivateInterval = 0;
  }

  initialize(): void {
    this.pref = this.background.pref;
    this.container = this.background.container;
    this.request = this.background.request;
    this.mouseclick = this.background.mouseclick;
    this.mac = this.background.mac;
    this.management = this.background.management;
    this.utils = this.background.utils;
    this.browseraction = this.background.browseraction;
    this.pageaction = this.background.pageaction;
    this.storage = this.background.storage;
    this.debug('[initialize] isolation initialized', this.storage.local.isolation);
    if (this.storage.local.isolation.reactivateTargetTime) {
      this.setActiveState(this.storage.local.isolation.reactivateTargetTime < new Date().getTime());
    }
  }

  async maybeIsolate({
    tab,
    request,
    openerTab,
    macAssignment,
  }: {
    tab?: Tab;
    request: WebRequestOnBeforeRequestDetails;
    openerTab?: Tab;
    macAssignment?: MacAssignment;
  }): Promise<boolean | { cancel: true }> {
    if (!this.getActiveState()) {
      this.debug('[maybeIsolate] isolation is disabled');
      return false;
    }
    if (tab && request && request.originUrl && this.mac.isConfirmPage(request.originUrl)) {
      this.debug('[maybeIsolate] we are coming from a mac confirm page');
      this.mac.containerConfirmed[tab.id] = tab.cookieStoreId;
      return false;
    }

    if (
      this.mouseclick.isolated[request.url] &&
      tab &&
      tab.cookieStoreId !== `${this.background.containerPrefix}-default` &&
      this.container.urlCreatedContainer[request.url] === tab.cookieStoreId
    ) {
      this.debug('[maybeIsolate] link click already created this container, we can stop here', request, tab);
      return false;
    }

    const isolate = await this.shouldIsolate({
      tab,
      request,
      openerTab,
      macAssignment,
    });
    if (!isolate) {
      this.debug('[maybeIsolate] decided to not isolate', tab, request);
      return false;
    }
    this.debug('[maybeIsolate] decided to isolate', tab, request);

    const excludedDomainPatterns = this.pref.isolation.global.excluded;
    if (excludedDomainPatterns.length) {
      const excluded = excludedDomainPatterns.find(excludedDomainPattern => {
        return this.utils.matchDomainPattern(request.url, excludedDomainPattern);
      });
      if (excluded) {
        this.debug('[maybeIsolate] request url matches global excluded domain pattern', request, excludedDomainPatterns);
        return false;
      }
    }

    if (tab && this.container.isPermanent(tab.cookieStoreId) && this.pref.isolation.global.excludedContainers.includes(tab.cookieStoreId)) {
      this.debug('[maybeIsolate] container on global excluded containers list', tab);
      return false;
    }

    if (macAssignment && tab && this.mac.containerConfirmed[tab.id] && tab.cookieStoreId === this.mac.containerConfirmed[tab.id]) {
      this.debug('[maybeIsolate] mac confirmed container, not isolating', this.mac.containerConfirmed, macAssignment);
      return false;
    }

    this.debug('[maybeIsolate] isolating', tab, request);
    if (this.request.cancelRequest(request)) {
      this.debug('[maybeIsolate] canceling request');
      return { cancel: true };
    }

    if (macAssignment && (!tab || (tab && tab.cookieStoreId !== macAssignment.cookieStoreId))) {
      this.debug('[maybeIsolate] decided to reopen but mac assigned, maybe reopen confirmpage', request, tab, macAssignment);
      this.mac.maybeReopenConfirmPage(macAssignment, request, tab, true);
      return false;
    }

    const params = {
      tab,
      url: request.url,
      request,
      deletesHistory: this.pref.deletesHistory.containerIsolation === 'automatic',
    };

    let reload = false;
    if (typeof isolate === 'object') {
      if (isolate.deletesHistory) {
        params.deletesHistory = true;
      }

      if (isolate.reload) {
        reload = true;
      }
    }

    if (tab && (reload || tab.url === 'about:home' || tab.url === 'about:newtab' || tab.url === 'about:blank' || this.pref.replaceTabs)) {
      await this.container.reloadTabInTempContainer(params);
    } else {
      await this.container.createTabInTempContainer(params);
    }
    return { cancel: true };
  }

  async shouldIsolate({
    tab,
    request,
    openerTab,
    macAssignment,
  }: {
    tab?: Tab;
    request: WebRequestOnBeforeRequestDetails;
    openerTab?: Tab;
    macAssignment?: MacAssignment;
  }): Promise<boolean | Record<string, unknown>> {
    this.debug('[shouldIsolate]', tab, request);

    // special-case TST group tabs #264
    if (openerTab && this.management.addons.get('treestyletab@piro.sakura.ne.jp')?.enabled) {
      const treeItem = await this.getTreeStyleTabItem(openerTab.id);
      if (treeItem && Array.isArray(treeItem.states) && treeItem.states.includes('group-tab')) {
        this.debug('[shouldIsolate] not isolating because originated from TST group tag', openerTab, tab, request);
        return false;
      }
    }

    return (
      this.shouldIsolateMouseClick({ request, tab, openerTab }) ||
      this.shouldIsolateMac({ tab, macAssignment }) ||
      (await this.shouldIsolateNavigation({ request, tab, openerTab })) ||
      (await this.shouldIsolateAlways({ request, tab, openerTab }))
    );
  }

  private async getTreeStyleTabItem(tabId: number): Promise<{ states?: string[] } | undefined> {
    return new Promise(resolve => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        this.debug(
          `[shouldIsolate] Tree Style Tab did not answer within ${this.treeStyleTabMessageTimeoutMs}ms; continuing isolation decision`
        );
        resolve(undefined);
      }, this.treeStyleTabMessageTimeoutMs);

      browser.runtime
        .sendMessage('treestyletab@piro.sakura.ne.jp', {
          tab: tabId,
          type: 'get-tree',
        })
        .then(response => {
          if (settled) {
            return;
          }
          settled = true;
          window.clearTimeout(timeout);
          resolve(response as { states?: string[] } | undefined);
        })
        .catch(error => {
          if (settled) {
            return;
          }
          settled = true;
          window.clearTimeout(timeout);
          this.debug('[shouldIsolate] failed contacting TST', (error as Error).toString());
          resolve(undefined);
        });
    });
  }

  shouldIsolateMouseClick({
    request,
    tab,
    openerTab,
  }: {
    tab?: Tab;
    request: WebRequestOnBeforeRequestDetails;
    openerTab?: Tab;
  }): boolean | Record<string, unknown> {
    if (!this.mouseclick.isolated[request.url]) {
      return false;
    }
    const isolatedClick = this.mouseclick.isolated[request.url];

    if (tab) {
      const relatedTabIds: number[] = [tab.id];
      if (typeof tab.openerTabId === 'number') {
        relatedTabIds.push(tab.openerTabId);
      }
      if (openerTab) {
        relatedTabIds.push(openerTab.id);
      }

      if (isolatedClick.tabId !== null && !relatedTabIds.includes(isolatedClick.tabId)) {
        this.debug(
          '[shouldIsolateMouseClick] isolated click came from unrelated tab, ignoring',
          isolatedClick,
          relatedTabIds,
          tab,
          openerTab,
          request
        );
        return false;
      }
    }

    if (isolatedClick.action === 'always') {
      this.debug('[shouldIsolateMouseClick] isolated click action is always', request, tab);
      return true;
    }

    if (isolatedClick.action === 'never') {
      this.debug('[shouldIsolateMouseClick] isolated click action is never', request, tab);
      return false;
    }

    if (isolatedClick.action === 'differentFromTabDomain') {
      if (!tab || !/^https?:/.test(tab.url)) {
        return true;
      }
      const tabUrl = new URL(tab.url);
      const requestUrl = new URL(request.url);
      return tabUrl.hostname !== requestUrl.hostname;
    }

    if (isolatedClick.action === 'differentFromTabDomainAndSubDomain') {
      if (!tab || !/^https?:/.test(tab.url)) {
        return true;
      }
      const tabUrl = new URL(tab.url);
      const requestUrl = new URL(request.url);
      return this.utils.getDomain(tabUrl.hostname) !== this.utils.getDomain(requestUrl.hostname);
    }

    return false;
  }

  shouldIsolateMac({ tab, macAssignment }: { tab?: Tab; macAssignment?: MacAssignment }): boolean | Record<string, unknown> {
    if (!macAssignment || !tab) {
      return false;
    }
    if (macAssignment.neverAsk) {
      return false;
    }
    if (tab.cookieStoreId === macAssignment.cookieStoreId) {
      return false;
    }
    if (this.mac.containerConfirmed[tab.id] && tab.cookieStoreId === this.mac.containerConfirmed[tab.id]) {
      return false;
    }
    return true;
  }

  async shouldIsolateNavigation({
    request,
    tab,
    openerTab,
  }: {
    request: WebRequestOnBeforeRequestDetails;
    tab?: Tab;
    openerTab?: Tab;
  }): Promise<boolean | Record<string, unknown>> {
    if (this.pref.isolation.navigation.action === 'never') {
      return false;
    }

    const target = await this.getNavigationTarget({ request, tab, openerTab });
    if (!target) {
      return false;
    }

    const action = await this.getIsolationAction({
      request,
      tab,
      openerTab,
      target,
      preference: this.pref.isolation.navigation.action,
    });
    if (!action) {
      return false;
    }

    return this.getIsolationResult(action);
  }

  async shouldIsolateAlways({
    request,
    tab,
    openerTab,
  }: {
    request: WebRequestOnBeforeRequestDetails;
    tab?: Tab;
    openerTab?: Tab;
  }): Promise<boolean | Record<string, unknown>> {
    if (this.pref.isolation.global.action === 'never') {
      return false;
    }

    const action = await this.getIsolationAction({
      request,
      tab,
      openerTab,
      target: request.url,
      preference: this.pref.isolation.global.action,
    });
    if (!action) {
      return false;
    }

    return this.getIsolationResult(action);
  }

  async getNavigationTarget({
    request,
    tab,
    openerTab,
  }: {
    request: WebRequestOnBeforeRequestDetails;
    tab?: Tab;
    openerTab?: Tab;
  }): Promise<string | false> {
    if (request.originUrl) {
      return request.originUrl;
    }
    if (openerTab && /^https?:/.test(openerTab.url)) {
      return openerTab.url;
    }
    if (tab && /^https?:/.test(tab.url)) {
      return tab.url;
    }
    return false;
  }

  async getIsolationAction({
    request,
    tab,
    openerTab,
    target,
    preference,
  }: {
    request: WebRequestOnBeforeRequestDetails;
    tab?: Tab;
    openerTab?: Tab;
    target: string;
    preference: IsolationAction;
  }): Promise<IsolationAction | false> {
    if (preference === 'never') {
      return false;
    }

    if (preference === 'always') {
      return 'always';
    }

    const requestUrl = new URL(request.url);
    const targetUrl = new URL(target);

    if (preference === 'differentFromDomain') {
      return requestUrl.hostname !== targetUrl.hostname ? preference : false;
    }

    if (preference === 'differentFromDomainAndSubDomain') {
      return this.utils.getDomain(requestUrl.hostname) !== this.utils.getDomain(targetUrl.hostname) ? preference : false;
    }

    if (preference === 'differentFromContainer') {
      if (!tab) {
        return preference;
      }
      if (tab.cookieStoreId === `${this.background.containerPrefix}-default`) {
        return preference;
      }
      if (this.container.isPermanent(tab.cookieStoreId)) {
        return false;
      }
      return preference;
    }

    if (preference === 'differentFromTabDomain') {
      if (!tab || !/^https?:/.test(tab.url)) {
        return preference;
      }
      const tabUrl = new URL(tab.url);
      return requestUrl.hostname !== tabUrl.hostname ? preference : false;
    }

    if (preference === 'differentFromTabDomainAndSubDomain') {
      if (!tab || !/^https?:/.test(tab.url)) {
        return preference;
      }
      const tabUrl = new URL(tab.url);
      return this.utils.getDomain(requestUrl.hostname) !== this.utils.getDomain(tabUrl.hostname) ? preference : false;
    }

    this.debug('[getIsolationAction] unknown preference', preference, request, tab, openerTab);
    return false;
  }

  getIsolationResult(action: IsolationAction): Record<string, unknown> {
    if (action === 'always') {
      return {};
    }

    if (action === 'differentFromDomain' || action === 'differentFromDomainAndSubDomain') {
      return {
        reload: true,
      };
    }

    if (action === 'differentFromContainer' || action === 'differentFromTabDomain' || action === 'differentFromTabDomainAndSubDomain') {
      return {};
    }

    return {};
  }

  getActiveState(): boolean {
    if (this.storage.local.isolation.reactivateTargetTime && this.storage.local.isolation.reactivateTargetTime < new Date().getTime()) {
      this.setActiveState(true);
    }
    return this.storage.local.isolation.active;
  }

  setActiveState(active: boolean): void {
    this.storage.local.isolation.active = active;
    this.storage.persist();
    this.browseraction.setIsolationState(active);
    this.pageaction.setIsolationState(active);
  }

  async toggleActiveState(): Promise<void> {
    this.setActiveState(!this.getActiveState());
  }

  async reactivateLater(): Promise<void> {
    if (this.reactivateInterval) {
      window.clearInterval(this.reactivateInterval);
    }
    const target = new Date().getTime() + this.pref.isolation.reactivateLater * 60 * 1000;
    this.storage.local.isolation.reactivateTargetTime = target;
    this.storage.persist();
    this.setActiveState(false);
    this.reactivateInterval = window.setInterval(() => {
      if (this.storage.local.isolation.reactivateTargetTime && this.storage.local.isolation.reactivateTargetTime < new Date().getTime()) {
        window.clearInterval(this.reactivateInterval);
        this.setActiveState(true);
      }
    }, 1000);
  }
}
