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

import {TAG} from './vars';

function log(...args_: any[]) {
  if (typeof (window as any)._LOG !== "undefined") {
    const args = Array.prototype.slice.call(arguments);
    args.unshift(`[Window Messenger: ${location.origin}]`);
    console.log.apply(window.console, args);
  }
}

interface MessengerTopics {
    CONNECT_HANDSHAKE: string,
    NOTIFICATION_PERMISSION_STATE: string,
    SERVICE_WORKER_STATE: string,
    SERVICE_WORKER_REGISTRATION: string,
    SERVICE_WORKER_QUERY: string,
    ORIGIN_SUBSCRIPTION_STATE: string,
}

interface MessengerOptions {
  debug: boolean,
  windowContext: (Window|undefined),
}

 /**
 * @fileoverview
 * A Promise-based PostMessage helper to ease back-and-forth replies.
 *
 * This class is included separately a second time, by websites running
 * amp-web-push, as well as by other push vendors, in a remote website's iframe.
 * It should therefore keep external depenencies to a minimum, since this class
 * must be transpiled to ES5 and "duplicated" outside of the AMP SDK bundle.
 */
export class WindowMessenger {

  /**
   * A map of randomly generated transient unique message IDs to metadata
   * describing incoming replies and outgoing sends. Just used to internally
   * keep track of replies and sends.
   */
  private messages_: Map<string, any>;

  /**
   * A map of string topic names to callbacks listeners interested in replies
   * to the topic.
   */
  private listeners_: Map<string, Array<any>|null>;
  private debug_: boolean;
  private listening_: boolean;
  private connecting_: boolean;
  private connected_: boolean;
  private channel_: MessageChannel;
  private messagePort_: MessagePort;

  private onListenConnectionMessageReceivedProc_;
  private onConnectConnectionMessageReceivedProc_;
  private onChannelMessageReceivedProc_;
  private window_: Window;

  /**
   * Set debug to true to get console logs anytime a message is received,
   * sent, or discarded.
   *
   * @param {MessengerOptions} options
   */
  constructor(options) {
    if (!options) {
      options = {
        debug: false,
        windowContext: window,
      };
    }

    this.messages_ = {} as any;
    this.listeners_ = {} as any;
    this.debug_ = options.debug;
    this.listening_ = false;
    this.connecting_ = false;
    this.connected_ = false;
    this.channel_ = null;

    this.messagePort_ = null;

    this.onListenConnectionMessageReceivedProc_ = null;
    this.onConnectConnectionMessageReceivedProc_ = null;
    this.onChannelMessageReceivedProc_ = null;
    this.window_ = options.windowContext || window;
  }

  /**
   * Starts Messenger in "listening" mode. In this mode, we listen as soon as
   * possible and expect a future postMessage() to establish a MessageChannel.
   * The remote frame initiates the connection.
   *
   * @param allowedOrigins A list of string origins to check against when
   *     receiving connection messages. A message from outside this list of
   *     origins won't be accepted.
   * @param delayConnectHandshake Allows this frame to partially connect with
   * another frame, but suspends the final connection handshake indefinitely to
   * run other code.
   * @returns A Promise that resolves when another frame successfully
   *      establishes a messaging channel, or rejects on error.
   */
  public listen(allowedOrigins: Array<string>, delayConnectHandshake?: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connected_) {
        reject(new Error('Already connected.'));
        return;
      }
      if (this.listening_) {
        reject(new Error('Already listening for connections.'));
        return;
      }
      if (!Array.isArray(allowedOrigins)) {
        reject(new Error('allowedOrigins should be a string array of ' +
          'allowed origins to accept messages from. Got:' + allowedOrigins));
        return;
      }
      this.onListenConnectionMessageReceivedProc_ =
        this.onListenConnectionMessageReceived_.bind(
            this,
            allowedOrigins,
            resolve,
            reject
        );
      this.window_.addEventListener('message',
        /** @type {(function (Event): (boolean|undefined)|null)} */
        (this.onListenConnectionMessageReceivedProc_));
      if (this.debug_) {
        log('Listening for a connection message...');
      }
    }).then(() => {
      if (delayConnectHandshake) {
        if (this.debug_) {
          log('Delaying connection handshake indefinitely...');
        }
      } else {
        this.send(WindowMessenger.Topics.CONNECT_HANDSHAKE, null);
        this.connected_ = true;
      }
    });
  }

  /**
   * Call this only if listen(delayConnectHandshake: true) was called.
   *
   * Finishes establishing the suspended connection.
   */
  public finishListenHandshake() {
    this.send(WindowMessenger.Topics.CONNECT_HANDSHAKE, null);
    this.connected_ = true;
  }

  /**
   * Determine if a postMessage message came from a trusted origin.
   *
   * Messages can arrive from any origin asking for information, so we want to
   * restrict messages to allowed origins. Messages can arrive from the Google
   * AMP Cache (https://www.google.com/amp), from the site itself
   * (https://your-site.com), and from other sources.
   *
   * The message's source origin just needs to be an entry in our list
   * (normalized).
   */
  private isAllowedOrigin_(origin: string, allowedOrigins: Array<string>): boolean {
    const normalizedOrigin = new URL(origin).origin;
    for (let i = 0; i < allowedOrigins.length; i++) {
      const allowedOrigin = allowedOrigins[i];
      // A user might have mistyped the allowed origin, so let's normalize our
      // comparisons first
      if (new URL(allowedOrigin).origin === normalizedOrigin) {
        return true;
      }
    }
    return false;
  }

  /**
   * Occurs when the messenger receives its step 1 internal connection message.
   */
  private onListenConnectionMessageReceived_(
    allowedOrigins: Array<string>,
    resolvePromise: () => void,
    rejectPromise: () => void,
    messageChannelEvent: MessageEvent
  ) {
    const message = messageChannelEvent.data;
    const {origin, ports: messagePorts} = messageChannelEvent;
    if (this.debug_) {
      log('Window message for listen() connection ' +
        'received:', message);
    }
    if (!this.isAllowedOrigin_(origin, allowedOrigins)) {
      log(`Discarding connection message from ${origin} ` +
        'because it isn\'t an allowed origin:', message, ' (allowed ' +
        ' origins are)', allowedOrigins);
      return;
    }
    if (!message ||
         message['topic'] !== WindowMessenger.Topics.CONNECT_HANDSHAKE) {
      log('Discarding connection message because it did ' +
        'not contain our expected handshake:', message);
      return;
    }

    log('Received expected connection handshake ' +
      'message:', message);
    // This was our expected handshake message Remove our message handler so we
    // don't get spammed with cross-domain messages
    this.window_.removeEventListener('message',
        /** @type {(function (Event): (boolean|undefined)|null)} */
        (this.onListenConnectionMessageReceivedProc_));
    // Get the message port
    this.messagePort_ = messagePorts[0];
    this.onChannelMessageReceivedProc_ =
      this.onChannelMessageReceived_.bind(this);
    this.messagePort_.addEventListener('message',
        this.onChannelMessageReceivedProc_, false);
    this.messagePort_.start();
    resolvePromise();
  }

  /**
   * Establishes a message channel with a listening Messenger on another frame.
   * Only call this if listen() has already been called on the remote frame.
   *
   * @param remoteWindowContext The Window context to postMessage()
   *     to.
   * @param expectedRemoteOrigin The origin the remote frame is
   *     required to be when receiving the message; the remote message is
   *     otherwise discarded.
   */
  connect(remoteWindowContext: Window, expectedRemoteOrigin: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!remoteWindowContext) {
        reject(new Error('Provide a valid Window context to connect to.'));
      }
      if (!expectedRemoteOrigin) {
        reject(new Error('Provide an expected origin for the remote Window ' +
        'or provide the wildcard *.'));
      }
      if (this.connected_) {
        reject(new Error('Already connected.'));
        return;
      }
      if (this.connecting_) {
        reject(new Error('Already connecting.'));
        return;
      }
      this.channel_ = new MessageChannel();
      this.messagePort_ = this.channel_.port1;
      this.onConnectConnectionMessageReceivedProc_ =
        this.onConnectConnectionMessageReceived_.bind(
            this,
            this.messagePort_,
            expectedRemoteOrigin,
            resolve)
        ;
      this.messagePort_.addEventListener('message',
          this.onConnectConnectionMessageReceivedProc_);
      this.messagePort_.start();
      remoteWindowContext.postMessage(
        /** @type {JsonObject} */ ({
          topic: WindowMessenger.Topics.CONNECT_HANDSHAKE,
        }), expectedRemoteOrigin === '*' ?
                '*' :
                new URL(expectedRemoteOrigin).origin, [this.channel_.port2]);
      log(`Opening channel to ${expectedRemoteOrigin}...`);
    });
  }

  /**
   * Occurs when the messenger receives its step 2 internal connection message.
   */
  private onConnectConnectionMessageReceived_(
    messagePort: MessagePort,
    expectedRemoteOrigin: string,
    resolvePromise: () => void) {
    // This is the remote frame's reply to our initial handshake topic message
    this.connected_ = true;
    if (this.debug_) {
      log(`Messenger channel to ${expectedRemoteOrigin} ` +
        'established.');
    }
    // Remove our message handler
    messagePort.removeEventListener('message',
        this.onConnectConnectionMessageReceivedProc_);
    // Install a new message handler for receiving normal messages
    this.onChannelMessageReceivedProc_ =
      this.onChannelMessageReceived_.bind(this);
    messagePort.addEventListener('message',
        this.onChannelMessageReceivedProc_, false);
    resolvePromise();
  }

  /**
   * Describes the list of available message topics.
   */
  static get Topics(): MessengerTopics {
    return {
      CONNECT_HANDSHAKE: 'topic-connect-handshake',
      NOTIFICATION_PERMISSION_STATE: 'topic-notification-permission-state',
      SERVICE_WORKER_STATE: 'topic-service-worker-state',
      SERVICE_WORKER_REGISTRATION: 'topic-service-worker-registration',
      SERVICE_WORKER_QUERY: 'topic-service-worker-query',
      ORIGIN_SUBSCRIPTION_STATE: 'topic-origin-subscription-state',
    };
  }

  /**
   * Occurs when a message is received via MessageChannel.
   * Messages received here are trusted (they aren't postMessaged() over).
   */
  private onChannelMessageReceived_(event: MessageEvent) {
    const message = event.data;
    if (this.messages_[message['id']] && message['isReply']) {
      const existingMessage = this.messages_[message['id']];
      delete this.messages_[message['id']];
      const promiseResolver = existingMessage.promiseResolver;
        // Set new incoming message data on existing message
      existingMessage.message = message['data'];
      if (this.debug_) {
        log(`Received reply for topic '${message['topic']}':`,
            message['data']);
      }
      promiseResolver([
        message['data'],
        this.sendReply_.bind(this, message['id'], existingMessage['topic']),
      ]);
    } else {
      const listeners = this.listeners_[message['topic']];
      if (!listeners) {
        return;
      }
      if (this.debug_) {
        log('Received new message for ' +
          `topic '${message['topic']}': ${message['data']}`);
      }
      for (let i = 0; i < listeners.length; i++) {
        const listener = listeners[i];
        listener(message['data'],
            this.sendReply_.bind(this, message['id'], message['topic']));
      }
    }
  }

  /**
   * Subscribes a callback to be fired anytime a new message is received on the
   * topic. Replies to an existing message fire on the existing message promise
   * chain, not on this method, even if the topic matches.
   */
  on(topic: string, callback: (...args) => void) {
    if (this.listeners_[topic]) {
      this.listeners_[topic].push(callback);
    } else {
      this.listeners_[topic] = [callback];
    }
  }

  /**
   * Removes the mapping subscribing the callback to a new message topic.
   */
  off(topic: string, callback: (...args) => void) {
    if (callback) {
      const callbackIndex = this.listeners_[topic].indexOf(callback);
      if (callbackIndex !== -1) {
        this.listeners_[topic].splice(callbackIndex, 1);
      }
    } else {
      // No specific callback provided; remove all listeners for topic
      if (this.listeners_[topic]) {
        delete this.listeners_[topic];
      }
    }
  }

  /**
   * id, and topic is supplied by .bind(..). When sendReply is called by the
   * user, only the 'data' parameter is provided
   */
  private sendReply_(id: string, topic: string, data: any): Promise<void> {
    const payload = {
      id,
      topic,
      data,
      isReply: true,
    };
    /*
     postMessage() requires the provided targetOrigin to match the recipient's
     origin, otherwise the message is not sent. Since we just got a message, we
     already know the receipient's origin.
     */
    this.messagePort_.postMessage(payload);

    return new Promise(resolve => {
      this.messages_[payload.id] = {
        message: data,
        topic,
        promiseResolver: resolve,
      };
    });
  }

  /**
   * Sends a message with the given topic, and data.
   */
  public send(topic: string, data: any): Promise<void> {
    const payload = {
      id: (<Uint8Array>crypto.getRandomValues(new Uint8Array(10))).join(''),
      topic,
      data,
    };
    if (this.debug_) {
      log(`Sending ${topic}:`, data);
    }
    this.messagePort_.postMessage(payload);

    return new Promise(resolve => {
      this.messages_[payload.id] = {
        message: data,
        topic,
        promiseResolver: resolve,
      };
    });
  }
}
