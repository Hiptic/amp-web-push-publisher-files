import { WindowMessenger } from './window-messenger';
import { SubscriptionStateMessage, ServiceWorkerMessage } from './amp-web-push-helper-frame';

/**
 * This JavaScript file is executed on a page like:
 *   - https://subdomain.onesignal.com/amp-remote-frame.html
 *   - https://subdomain.os.tc/amp-remote-frame.html
 *   - https://old-push-domain.example.com/amp-remote-frame.html
 *
 * It's used in AMP web push when there are multiple origins a user can be
 * subscribed to. For OneSignal HTTP sites, users may have an existing
 * subscription on subdomain.onesignal.com or a new subscription on
 * subdomain.os.tc. Because AMP web push only checks and subscribes to one site,
 * users who are subscribed to an alternate origin would be prompted to
 * subscribe and would receive duplicate notifications.
 *
 * This JavaScript file is what runs on each origin that will be checked. It
 * communicates the Notification permission and service worker state back to the
 * other half of this checker script that will then block loading AMP web push
 * to prevent double subscriptions, if an alternate origin subscription is
 * identified.
 */
export class AmpRemoteFrame {

  /**
   * Describes the messages we allow through from the service worker. Whenever
   * the AMP page sends a 'query service worker' message with a topic string,
   * we add the topic to the allowed list, and wait for the service worker to
   * reply. Once we get a reply, we remove it from the allowed topics.
   */
  private allowedWorkerMessageTopics_: object;

  constructor() {
    this.allowedWorkerMessageTopics_ = {};
  }

  async run() {
    log("Checking for an existing subscription...");
    navigator.serviceWorker.addEventListener('message',
        this.onPageMessageReceivedFromServiceWorker_.bind(this));
    const messenger = new WindowMessenger({
      debug: false,
      windowContext: window,
    });
    await messenger.connect(window.parent, '*');

    const subscriptionState = await this.getSubscriptionState();
    messenger.send(WindowMessenger.Topics.ORIGIN_SUBSCRIPTION_STATE, subscriptionState);
  }

  /**
   * @param {!Event} event
   * @private
   */
  onPageMessageReceivedFromServiceWorker_(event) {
    const {command, payload} = event.data;
    const callbackPromiseResolver = this.allowedWorkerMessageTopics_[command];

    if (typeof callbackPromiseResolver === 'function') {
      // Resolve the waiting listener with the worker's reply payload
      callbackPromiseResolver(payload);
    }
    // Otherwise, ignore unsolicited messages from the service worker
  }

  async getSubscriptionState(): Promise<SubscriptionStateMessage> {
    const state = {
      notificationPermission: (window as any).Notification.permission,
      serviceWorkerUrl: undefined,
      serviceWorkerState: undefined,
      serviceWorkerIsControllingFrame: undefined,
      serviceWorkerSubscriptionState: undefined,
    };

    if (navigator.serviceWorker) {
      if (navigator.serviceWorker.controller) {
        state.serviceWorkerUrl = navigator.serviceWorker.controller.scriptURL;
        state.serviceWorkerState = navigator.serviceWorker.controller.state;
        state.serviceWorkerIsControllingFrame = true;

        const subscriptionState = await this.messageServiceWorkerAndAwaitReply({
          topic: 'amp-web-push-subscription-state',
          payload: null
        });

        state.serviceWorkerSubscriptionState = subscriptionState;
      }
    }

    log('Subscription state summary:', state);

    return state;
  }

  async messageServiceWorkerAndAwaitReply(message: ServiceWorkerMessage) {
    return new Promise(resolve => {
      // Allow this message through, just for the next time it's received
      this.allowedWorkerMessageTopics_[message.topic] = resolve;

      // The AMP message is forwarded to the service worker
      this.waitUntilWorkerControlsPage().then(() => {
        navigator.serviceWorker.controller.postMessage({
          command: message.topic,
          payload: message.payload,
        });
      });
    }).then(workerReplyPayload => {
      delete this.allowedWorkerMessageTopics_[message.topic];
      return workerReplyPayload;
    });
  }

  /**
    * Service worker postMessage() communication relies on the property
    * navigator.serviceWorker.controller to be non-null. The controller property
    * references the active service worker controlling the page. Without this
    * property, there is no service worker to message.
    *
    * The controller property is set when a service worker has successfully
    * registered, installed, and activated a worker, and when a page isn't
    * loaded in a hard refresh mode bypassing the cache.
    *
    * It's possible for a service worker to take a second page load to be fully
    * activated.
    *
    * @return {boolean}
    * @private
    */
  isWorkerControllingPage_() {
    return navigator.serviceWorker &&
      navigator.serviceWorker.controller &&
      navigator.serviceWorker.controller.state === 'activated';
  }

  /**
   * Returns a Promise that is resolved when the the page controlling the
   * service worker is activated. This Promise never rejects.
   *
   * @return {Promise}
   */
  waitUntilWorkerControlsPage() {
    return new Promise(resolve => {
      if (this.isWorkerControllingPage_()) {
        resolve();
      } else {
        navigator.serviceWorker.addEventListener(
            'controllerchange', () => {
          // Service worker has been claimed
              if (this.isWorkerControllingPage_()) {
                resolve();
              } else {
                navigator.serviceWorker.controller
                    .addEventListener(
                    'statechange',
                    () => {
                      if (this.isWorkerControllingPage_()) {
                        // Service worker has been activated
                        resolve();
                      }
                    });
              }
            });
      }
    });
  }
}

function log(...args_: any[]) {
  if (typeof (window as any)._LOG !== "undefined") {
    const args = Array.prototype.slice.call(arguments);
    args.unshift(`[Remote Frame: ${location.origin}]`);
    console.log.apply(window.console, args);
  }
}

new AmpRemoteFrame().run();