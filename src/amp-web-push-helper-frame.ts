/**
 * Copyright 2017 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */

import {parseQueryString} from './utils';
import {WindowMessenger} from './window-messenger';
import { NotificationPermission } from './vars';

interface HelperFrameOptions {
  debug: boolean,
  windowContext: Window,
}

export interface ServiceWorkerMessage {
  topic: string,
  payload: any
}

export interface SubscriptionStateMessage {
  notificationPermission: NotificationPermission,
  serviceWorkerUrl: string;
  serviceWorkerState: string;
  serviceWorkerIsControllingFrame: boolean;
  serviceWorkerSubscriptionState: boolean;
}

export interface ServiceWorkerRegistrationMessage {
  workerUrl: string,
  registrationOptions: {scope: string}
}

 /**
  * @fileoverview
  * Loaded as an invisible iframe on the AMP page, and serving a page on the
  * canonical origin, this iframe enables same-origin access to push
  * subscription, notification permission, and IndexedDb data stored on the
  * canonical origin to query the user's permission state, register service
  * workers, and enable communication with the registered service worker.
  */
export class AmpWebPushHelperFrame {
  private debug_: boolean;
  private window_: Window;
  private ampMessenger_: WindowMessenger;
  private allowedWorkerMessageTopics_: Map<string, () => void>;

  constructor(options: HelperFrameOptions) {
    /**
     * Debug enables verbose logging for this page and the window and worker
     * messengers
     */
    this.debug_ = options && options.debug;
    this.window_ = options.windowContext || window;

    /**
     * For communication between the AMP page and this helper iframe
     */
    this.ampMessenger_ = new WindowMessenger({
      debug: this.debug_,
      windowContext: this.window_,
    });

    /**
     * Describes the messages we allow through from the service worker. Whenever
     * the AMP page sends a 'query service worker' message with a topic string,
     * we add the topic to the allowed list, and wait for the service worker to
     * reply. Once we get a reply, we remove it from the allowed topics.
     */
    this.allowedWorkerMessageTopics_ = {} as any;
  }

  public finishListenHandshake() {
    this.ampMessenger_.finishListenHandshake();
  }

  /**
   * Ensures replies to the AMP page messenger have a consistent payload format.
   */
  private replyToFrameWithPayload_(
    replyToFrameFunction: any,
    wasSuccessful: boolean,
    errorPayload: any,
    successPayload: any) {
    replyToFrameFunction({
      success: wasSuccessful,
      error: wasSuccessful ? undefined : errorPayload,
      result: wasSuccessful ? successPayload : undefined,
    });
  }

  private onAmpPageMessageReceivedNotificationPermissionState_(_: any, replyToFrame: any) {
    this.replyToFrameWithPayload_(
        replyToFrame,
        true,
        null,
        ((Notification as any).permission) as NotificationPermission
    );
  }

  private onAmpPageMessageReceivedServiceWorkerState_(_, replyToFrame) {
    const serviceWorkerState = {
      /*
        Describes whether navigator.serviceWorker.controller is non-null.

        A page hard-refreshed bypassing the cache will have the
        navigator.serviceWorker.controller property be null even if the service
        worker is successfully registered and activated. In these situations,
        communication with the service worker isn't possible since the
        controller is null.
       */
      isControllingFrame: !!this.window_.navigator.serviceWorker.controller,
      /*
        The URL to the service worker script.
       */
      url: this.window_.navigator.serviceWorker.controller ?
        this.window_.navigator.serviceWorker.controller.scriptURL :
        null,
      /*
        The state of the service worker, one of "installing, waiting,
        activating, activated".
       */
      state: this.window_.navigator.serviceWorker.controller ?
        this.window_.navigator.serviceWorker.controller.state :
        null,
    };

    this.replyToFrameWithPayload_(replyToFrame, true, null, serviceWorkerState);
  }

  private onAmpPageMessageReceivedServiceWorkerRegistration_(message: ServiceWorkerRegistrationMessage, replyToFrame: any) {
    if (!message || !message.workerUrl || !message.registrationOptions) {
      throw new Error('Expected arguments workerUrl and registrationOptions ' +
        'in message, got:' + message);
    }

    this.window_.navigator.serviceWorker.register(
        message.workerUrl,
        message.registrationOptions
    ).then(() => {
      this.replyToFrameWithPayload_(replyToFrame, true, null, null);
    })
        .catch(error => {
          this.replyToFrameWithPayload_(replyToFrame, true, null, error ?
        (error.message || error.toString()) :
        null
      );
        });
  }

  messageServiceWorker(message: ServiceWorkerMessage) {
    this.window_.navigator.serviceWorker.controller.postMessage({
      command: message.topic,
      payload: message.payload,
    });
  }

  private onAmpPageMessageReceivedServiceWorkerQuery_(message: ServiceWorkerMessage, replyToFrame) {
    if (!message || !message.topic) {
      throw new Error('Expected argument topic in message, got:' + message);
    }
    new Promise(resolve => {
      // Allow this message through, just for the next time it's received
      this.allowedWorkerMessageTopics_[message.topic] = resolve;

      // The AMP message is forwarded to the service worker
      this.waitUntilWorkerControlsPage().then(() => {
        this.messageServiceWorker(message);
      });
    }).then(workerReplyPayload => {
      delete this.allowedWorkerMessageTopics_[message.topic];

      // The service worker's reply is forwarded back to the AMP page
      return this.replyToFrameWithPayload_(
          replyToFrame,
          true,
          null,
          workerReplyPayload
      );
    });
  }

  private getParentOrigin_(): string {
    const queryParams = parseQueryString(this.window_.location.search);
    if (!queryParams['parentOrigin']) {
      throw new Error('Expecting parentOrigin URL query parameter.');
    }
    return queryParams['parentOrigin'];
  }

  private onPageMessageReceivedFromServiceWorker_(event: MessageEvent) {
    const {command, payload} = event.data;
    const callbackPromiseResolver = this.allowedWorkerMessageTopics_[command];

    if (typeof callbackPromiseResolver === 'function') {
      // Resolve the waiting listener with the worker's reply payload
      callbackPromiseResolver(payload);
    }
    // Otherwise, ignore unsolicited messages from the service worker
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
    */
  private isWorkerControllingPage_(): boolean {
    return this.window_.navigator.serviceWorker &&
      this.window_.navigator.serviceWorker.controller &&
      this.window_.navigator.serviceWorker.controller.state === 'activated';
  }

  /**
   * Returns a Promise that is resolved when the the page controlling the
   * service worker is activated. This Promise never rejects.
   */
  waitUntilWorkerControlsPage(): Promise<void> {
    return new Promise(resolve => {
      if (this.isWorkerControllingPage_()) {
        resolve();
      } else {
        this.window_.navigator.serviceWorker.addEventListener(
            'controllerchange', () => {
          // Service worker has been claimed
              if (this.isWorkerControllingPage_()) {
                resolve();
              } else {
                this.window_.navigator.serviceWorker.controller
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

  /**
   * Sets up message listeners for messages from the AMP page and service
   * worker.
   *
   * @param allowedOrigin For testing purposes only. Pass in the
   * allowedOrigin since test environments cannot access the parent origin.
   */
  listenPartially(allowedOrigin: string|null) {
    this.ampMessenger_.on(
        WindowMessenger.Topics.NOTIFICATION_PERMISSION_STATE,
        this.onAmpPageMessageReceivedNotificationPermissionState_.bind(this)
    );
    this.ampMessenger_.on(
        WindowMessenger.Topics.SERVICE_WORKER_STATE,
        this.onAmpPageMessageReceivedServiceWorkerState_.bind(this)
    );
    this.ampMessenger_.on(
        WindowMessenger.Topics.SERVICE_WORKER_REGISTRATION,
        this.onAmpPageMessageReceivedServiceWorkerRegistration_.bind(this)
    );
    this.ampMessenger_.on(
        WindowMessenger.Topics.SERVICE_WORKER_QUERY,
        this.onAmpPageMessageReceivedServiceWorkerQuery_.bind(this)
    );

    this.waitUntilWorkerControlsPage().then(() => {
      this.window_.navigator.serviceWorker.addEventListener('message',
          this.onPageMessageReceivedFromServiceWorker_.bind(this));
    });
    this.ampMessenger_.listen([allowedOrigin || this.getParentOrigin_()], true);
  }
}

export class AlternateSubscriptionChecker extends AmpWebPushHelperFrame {
  /**
   * An array of remote URLs, for example:
   *   - https://subdomain.onesignal.com/amp-remote-frame.html
   *
   * The array of remote URLs should be the list of origins users used to be
   * able to subscribe to. For example, an HTTPS site might have the following
   * old subscriptions:
   *   - https://subdomain.onesignal.com/amp-remote-frame.html
   *   - https://subdomain.os.tc/amp-remote-frame.html
   *
   * before deciding to switch to HTTPS. If the old apps are still being used,
   * to prevent duplicate subscriptions, existing subscribers on the above
   * origins should not be prompted. AMP web push will be disabled for these
   * users.
   */
  private urls: Array<string>;

  constructor(urls: Array<string>) {
    super({
      debug: false,
      windowContext: undefined,
    });
    this.urls = urls || [];
  }

  /**
   *
   */
  async run() {
    if (this.urls.length > 0) {
      for (const url of this.urls) {
        log(`Loading ${url} in a nested iframe to check for an existing subscription...`);
        const isSubscribed = await this.isSubscribedToAltOrigin(url);
        if (isSubscribed) {
          log(`${new URL(url).origin} has an active web push subscription. Suspending AMP web push to prevent duplicate subscriptions.`);
          await this.timeoutForever();
        } else {
          // Otherwise, the next URL will be checked for a subscription
          log(`No existing subscription detected on ${new URL(url).origin}.`);
        }
      }
    }
  }

  private async timeoutForever() {
    return await new Promise(resolve => {});
  }

  async isSubscribedToAltOrigin(url: string) {
    // Before loading the iframe, prepare a messenger to listen to messages from
    // the iframe
    const messenger = new WindowMessenger({
      debug: false,
      windowContext: window,
    });

   /*
    * The remote frame should automatically respond to our messenger to tell us
    * the remote origin's subscription state
    *
    *  It may also *not* reply because the remote origin can't communicate with
    *  the service worker. This is okay, because the AMP web push extension
    *  will never start up and it's less risky to not prompt someone if we're
    *  not sure they're unsubscribed.
    */
    const subscriptionStatePromise = new Promise<SubscriptionStateMessage>(resolve => {
      messenger.on(
          WindowMessenger.Topics.ORIGIN_SUBSCRIPTION_STATE,
          message => {
            resolve(message)
          }
      );
    });
    messenger.listen([new URL(url).origin]);

    // Load the remote URL into the iframe
    const iframe = await this.createIframe(url);

    /*
     * The remote frame should automatically respond to our messenger to tell us
     * the remote origin's subscription state
     *
     *  It may also *not* reply because the remote origin can't communicate with
     *  the service worker. This is okay, because the AMP web push extension
     *  will never start up and it's less risky to not prompt someone if we're
     *  not sure they're unsubscribed.
     */
    const subscriptionState: SubscriptionStateMessage = await subscriptionStatePromise;
    this.removeIframe(url);
    return subscriptionState.notificationPermission === "granted" &&
      subscriptionState.serviceWorkerIsControllingFrame === true &&
      subscriptionState.serviceWorkerState === "activated" &&
      subscriptionState.serviceWorkerSubscriptionState === true &&
      subscriptionState.serviceWorkerUrl.indexOf('OneSignalSDKWorker.js') !== -1;
  }

  /**
   * Creates an IFrame and returns a promise when the iframe's document has
   * finished loading, with the IFrame DOM element as the promise's resolved
   * value.
   */
  createIframe(url: string): Promise<HTMLIFrameElement> {
    const iframe = document.createElement('iframe');
    iframe.style.display = "none";
    iframe.src = url;
    const loadPromise = new Promise<HTMLIFrameElement>(resolve => {
      iframe.onload = () => resolve(iframe);
    });
    document.body.appendChild(iframe);
    return loadPromise;
  }

  removeIframe(url: string) {
    const iframe = document.querySelector(`iframe[src='${url}'`);
    if (iframe) {
      document.body.removeChild(iframe);
    }
  }
}

function log(...args_: any[]) {
  if (typeof (window as any)._LOG !== "undefined") {
    const args = Array.prototype.slice.call(arguments);
    args.unshift(`[Helper Frame: ${location.origin}]`);
    console.log.apply(window.console, args);
  }
}

async function run(urlsToCheck: string[]) {
  if (!Array.isArray(urlsToCheck)) {
    log("Parameter urlsToCheck is not an array:", urlsToCheck);
  }
  /*
    We're going to deviate from the way AMP web push's helper frame accepts
    connections from the parent AMP page, by accepting the initial connection
    from the parent AMP page, but then delaying the final OK response until
    we're done checking for existing subscriptions.

    This will cause the parent AMP page to not finish initializing the web push
    extension, and the visitor won't see any subscription (or unsubscription)
    button, because AMP web push won't show anything until it's had a chance to
    finish initializing.

    How the process works is:

    1. The parent AMP page opens an iframe to the helper frame URL. This current
         script right now is running as part of the helper frame.

    2. The parent AMP page, having opened this current iframe, will wait for
       this iframe's onload event. IFrame load events don't get called until all
       synchronous JavaScript finishes running, and all sub-resources on this
       page have been loaded.

       Ideally, we'd like to delay the onload event until we've:

         a) opened iframes to every alternate subscription origin

         b) confirmed each alternate subscription origin does not have an
            existing subscription

        However, there isn't any way in JavaScript to delay an onload event,
        and the onload event is called as soon as all *synchronous* JavaScript
        is finished running. That means promises are not waited on.

    3. As soon as the parent AMP page detects this iframe's load event has been
       called, it will send a connection message to this frame, which is handled
       by WindowMessenger.

       The problem is, if we asynchronously load and check each alternate origin
       for an existing subscription and then after everything is determined to
       be okay, wait for the original connection message from the parent AMP
       page, we'll be too late.

       So the solution is to *partially* accept the parent AMP page's connection
       message, but delay the final handshake sequence until we've finished
       checking for all extra subscriptions.

       To do this, we have to modify WindowMessenger from it's original AMP web
       push implementation, and add an extra parameter to the connect() call
       that delays the final handshake response. We expose a public method on
       WindowMessenger and HelperFrame that then resumes the final handshake
       response. The good thing is that we can indefinitely delay the response
       since the parent AMP page will wait indefinitely for the response.
   */

  log('Listening for parent AMP page connection message...');
  const helperFrame = new AmpWebPushHelperFrame({
    debug: true,
    windowContext: window
  });
  (window as any)._helperFrame = helperFrame;
  helperFrame.listenPartially(null);

  /*
    Load a specially prepared page on each origin below to check that origin's
    notification permission, service worker state, and push subscription state.

    The special page will be opened as a sub-iframe of this current iframe, and
    will reply back with that origin's subscription state.

    If any of the origins below have an existing subscription, we "freeze" the
    iframe and never respond to the parent AMP page so that the visitor doesn't
    have a chance to subscribe or unsubscribe.
   */
  log('Checking alternate origins for existing subscriptions...');
  const subscriptionChecker = new AlternateSubscriptionChecker(urlsToCheck);
  (window as any)._subscriptionChecker = subscriptionChecker;
  await subscriptionChecker.run();

  /*
    At this point, we've finished loading, checking, and unloading each of the
    URLs above to check for existing subscriptions. None exist.

    We then resume the final handshake sequence from the parent AMP page and
    restore the original AMP helper frame functionality so that the visitor can
    subscribe/unsubscribe.
   */
  log('No existing subscriptions were found on alternate origins. Restoring original AMP web push helper frame functionality.');
  helperFrame.finishListenHandshake();
}

(window as any).runAmpWebPushHelperFrame = run;
