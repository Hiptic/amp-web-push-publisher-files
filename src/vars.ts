export const TAG = 'amp-web-push';
export const CONFIG_TAG = TAG;
export const SERVICE_TAG = TAG + '-service';
export const WIDGET_TAG = TAG + '-widget';

/** @enum {string} */
export const NotificationPermission = {
  GRANTED: 'granted',
  DENIED: 'denied',
  /*
    Note: PushManager.permissionState() returns 'prompt';
    Notification.permission returns 'default'
   */
  DEFAULT: 'default',
};
