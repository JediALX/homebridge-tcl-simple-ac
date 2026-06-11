import { API } from 'homebridge';

import { TclSimpleAcPlatform } from './platform';
import { PLATFORM_NAME } from './settings';

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, TclSimpleAcPlatform);
};
