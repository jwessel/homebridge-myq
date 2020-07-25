/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * myq-api.ts: Our myQ API implementation.
 */
import { HAP, Logging } from "homebridge";
import fetch, { Response, RequestInfo, RequestInit } from "node-fetch";
import util from "util";

import {
  MYQ_API_APPID,
  MYQ_API_TOKEN_REFRESH_INTERVAL,
  MYQ_API_URL,
  MYQ_API_VERSION_MAJOR,
  MYQ_API_VERSION_MINOR
} from "./settings";

// A semi-complete description of the myQ account JSON.
// This is currently unused and documented here primarily for reference.
interface myQAccountInterface {
  Admin: boolean,
  Account: {
    href: string,
    AccessGroups: {
      href: string
    },
    AccessSchedules: {
      href: string
    },
    Address: {
      AddressLine1: string,
      AddressLine2: string,
      City: string,
      PostalCode: string,
      Country: {
        href: string,
        Code: string,
        IsEEACountry: boolean
      }
    },
    ContactName: string,
    Devices: {
      href: string
    },
    DirectoryCodeLength: number,
    Email: string,
    Id: string,
    Name: string,
    Phone: string,
    Roles: {
      href: string
    },
    TimeZone: string,
    Users: {
      href: string
    },
    UserAllowance: number,
    Zones: {
      href: string
    }
  },
  AnalyticsId: string,
  CultureCode: string,
  DiagnosticDataOptIn: boolean,
  Email: string,
  FirstName: string,
  LastName: string,
  Address: {
    AddressLine1: string,
    AddressLine2: string,
    City: string,
    PostalCode: string,
    Country: {
      href: string,
      Code: string,
      IsEEACountry: boolean
    }
  },
  MailingListOptIn: boolean,
  Phone: string,
  RequestAccountLinkInfo: boolean,
  TimeZone: { Id: string, Name: string },
  Users: { href: string },
  UserId: string,
  UserName: string
}

// A semi-complete description of the myQ device JSON.
interface myQDeviceInterface {
  created_date: string,
  device_family: string,
  device_platform: string,
  device_type: string,
  href: string,
  name: string,
  parent_device?: string,
  parent_device_id?: string,
  serial_number: string,
  state: {
    attached_work_light_error_present: boolean,
    aux_relay_behavior: string,
    aux_relay_delay: string,
    close: string,
    command_channel_report_status: boolean,
    control_from_browser: boolean,
    door_ajar_interval: string,
    door_state: string,
    dps_low_battery_mode?: boolean,
    firmware_version?: string,
    gdo_lock_connected: boolean,
    homekit_capable?: boolean,
    homekit_enabled?: boolean,
    invalid_credential_window: string,
    invalid_shutout_period: string,
    is_unattended_close_allowed: boolean,
    is_unattended_open_allowed: boolean,
    last_status: string,
    last_update: string,
    learn?: string,
    learn_mode?: boolean,
    max_invalid_attempts: number,
    online: boolean,
    open: string,
    passthrough_interval: string,
    pending_bootload_abandoned?: boolean,
    physical_devices?: [],
    report_ajar: boolean,
    report_forced: boolean,
    rex_fires_door: boolean,
    updated_date?: string,
    use_aux_relay: boolean
  }
}

// Hardware device information reference.
interface myQHwInfoInterface {
  product: string,
  brand: string
}

// We use types instead of interfaces here because we can more easily set the entire thing as readonly.
// Unfortunately, interfaces can't be quickly set as readonly in Typescript without marking each and
// every property as readonly along the way.
type myQAccount = Readonly<myQAccountInterface>;
export type myQDevice = Readonly<myQDeviceInterface>;
export type myQHwInfo = Readonly<myQHwInfoInterface>;

let debugMode = false;

/*
 * myQ API version information. This is more intricate than it seems because the myQ
 * API requires the major version number in some instances, and both the major and
 * minor version in others. Given the dynamic nature of the myQ API, expect this to
 * continue to evolve.
 */
const myQApiInfo = {
  baseUrl: MYQ_API_URL,

  // myQ API version, currently 5.1.
  majorVersion: MYQ_API_VERSION_MAJOR,
  minorVersion: MYQ_API_VERSION_MINOR,

  // myQ app identifier and user agent used to validate against the myQ API.
  appId: MYQ_API_APPID,
  userAgent: "okhttp/3.10.0",

  // Complete version string.
  version(): string {
    return this.majorVersion + "." + this.minorVersion;
  },

  // myQ login and account URL for API calls.
  url(): string {
    return this.baseUrl + "/v" + this.majorVersion;
  },

  // myQ devices URL for API calls.
  deviceUrl(): string {
    return this.baseUrl + "/v" + this.version();
  }
};

// Renew myQ security credentials every so often, in hours.
const myQTokenExpirationWindow = MYQ_API_TOKEN_REFRESH_INTERVAL * 60 * 60 * 1000;

/*
 * The myQ API is undocumented, non-public, and has been derived largely through
 * reverse engineering the official app, myQ website, and trial and error.
 *
 * This project stands on the shoulders of the other myQ projects out there that have
 * done much of the heavy lifting of decoding the API.
 *
 * Here's how the myQ API works:
 *
 * 1. Login to the myQ API and acquire security credentials for further calls to the API.
 * 2. Enumerate the list of myQ devices, including gateways and openers. myQ devices like
 *    garage openers or lights are associated with gateways. While you can have multiple
 *    gateways in a home, a more typical setup would be one gateway per home, and one or
 *    more devices associated with that gateway.
 * 3. To check status of myQ devices, we periodically poll to get updates on specific
 *    devices.
 *
 * Those are the basics and gets us up and running. There are further API calls that
 * allow us to open and close openers, lights, and other devices, as well as periodically
 * poll for status updates.
 *
 * That last part is key. Since there is no way that we know of to monitor status changes
 * in real time, we have to resort to polling the myQ API regularly to see if something
 * has happened that we're interested in (e.g. a garage door opening or closing). It
 * would be great if a monitor API existed to inform us when changes occur, but alas,
 * it either doesn't exist or hasn't been discovered yet.
 */

export class myQApi {
  Devices!: Array<myQDevice>;
  private email: string;
  private password: string;
  private accountId!: string;
  private securityToken!: string;
  private securityTokenTimestamp!: number;
  private log: Logging;
  private lastAuthenticateCall!: number;
  private lastRefreshDevicesCall!: number;

  // Headers that the myQ API expects.
  private headers = {
    "Content-Type": "application/json",
    "User-Agent": myQApiInfo.userAgent,
    "ApiVersion": myQApiInfo.version(),
    "BrandId": "2",
    "Culture": "en",
    "MyQApplicationId": myQApiInfo.appId,
    "SecurityToken": ""
  };

  // List all the door types we know about. For future use...
  private myQDoorTypes = [
    "commercialdooropener",
    "garagedooropener",
    "gate",
    "virtualgaragedooropener",
    "wifigaragedooropener"
  ];

  // Initialize this instance with our login information.
  constructor(log: Logging, email: string, password: string, wantDebug: boolean) {
    this.log = log;
    this.email = email;
    this.password = password;
    debugMode = wantDebug;
  }

  // Log us into myQ and get a security token.
  private async acquireSecurityToken(): Promise<boolean> {
    const now = Date.now();

    // Reset the API call time.
    this.lastAuthenticateCall = now;

    // Login to the myQ API and get a security token for our session.
    const response = await this.fetch(myQApiInfo.url() + "/Login", {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ UserName: this.email, Password: this.password })
    });

    if(!response) {
      this.log("myQ API: Unable to authenticate. Will retry later.");
      return false;
    }

    // Now let's get our security token.
    const data = await response.json();

    this.debug(util.inspect(data, { colors: true, sorted: true, depth: 3 }));

    // What we should get back upon successfully calling /Login is a security token for
    // use in future API calls this session.
    if(!data || !data.SecurityToken) {
      this.log("myQ API: Unable to acquire a security token.");
      return false;
    }

    // On initial plugin startup, let the user know we've successfully connected.
    if(!this.securityToken) {
      this.log("myQ API: Successfully connected to the myQ API.");
    }

    this.securityToken = data.SecurityToken;
    this.securityTokenTimestamp = now;

    this.debug("Token: %s", this.securityToken);

    // Add the token to our headers that we will use for subsequent API calls.
    this.headers.SecurityToken = this.securityToken;

    return true;
  }

  // Refresh the security token.
  private async checkSecurityToken(): Promise<boolean> {
    const now = Date.now();

    // If we don't have a security token yet, acquire one before proceeding.
    if(!this.accountId && !(await this.getAccount())) {
      return false;
    }

    // Is it time to refresh? If not, we're good for now.
    if((now - this.securityTokenTimestamp) < myQTokenExpirationWindow) {
      return true;
    }

    // We want to throttle how often we call this API to no more than once every 5 minutes.
    if((now - this.lastAuthenticateCall) < (5 * 60 * 1000)) {
      this.debug("myQ API: throttling acquireSecurityToken API call.");

      return true;
    }

    this.debug("myQ API: acquiring a new security token.");

    // Now generate a new security token.
    if(!(await this.acquireSecurityToken())) {
      return false;
    }

    return true;
  }

  // Get our myQ account information.
  private async getAccount(): Promise<boolean> {
    // If we don't have a security token yet, acquire one before proceeding.
    if(!this.securityToken && !(await this.acquireSecurityToken())) {
      return false;
    }

    // Get the account information.
    const params = new URLSearchParams({ expand: "account" });

    const response = await this.fetch(myQApiInfo.url() + "/My?" + params, {
      method: "GET",
      headers: this.headers
    });

    if(!response) {
      this.log("myQ API: Unable to login. Acquiring a new security token and retrying later.");
      await this.acquireSecurityToken();
      return false;
    }

    // Now let's get our account information.
    const data = await response.json();

    this.debug(util.inspect(data, { colors: true, sorted: true, depth: 3 }));

    // No account information returned.
    if(!data || !data.Account) {
      this.log("myQ API: Unable to retrieve account information from myQ servers.");
      return false;
    }

    // Save the user information.
    this.accountId = data.Account.Id;

    this.debug("myQ accountId: " + this.accountId);

    return true;
  }

  // Get the list of myQ devices associated with an account.
  async refreshDevices(): Promise<boolean> {
    const now = Date.now();

    // We want to throttle how often we call this API as a failsafe. If we call it more
    // than once every two seconds or so, bad things can happen on the myQ side leading
    // to potential account lockouts. The author definitely learned this one the hard way.
    if(this.lastRefreshDevicesCall && ((now - this.lastRefreshDevicesCall) < (2 * 1000))) {
      this.debug("myQ API: throttling refreshDevices API call. Using cached data from the past five seconds.");

      return this.Devices ? true : false;
    }

    // Reset the API call time.
    this.lastRefreshDevicesCall = now;

    // Validate and potentially refresh our security token.
    if(!(await this.checkSecurityToken())) {
      return false;
    }

    // Get the list of device information.
    const response = await this.fetch(myQApiInfo.deviceUrl() + "/Accounts/" + this.accountId + "/Devices", {
      method: "GET",
      headers: this.headers
    });

    if(!response) {
      this.log("myQ API: Unable to update device status from myQ servers. Acquiring a new security token and retrying later.");
      this.securityTokenTimestamp = 0;
      return false;
    }

    // Now let's get our account information.
    const data = await response.json();

    this.debug(util.inspect(data, { colors: true, sorted: true, depth: 3 }));

    const newDeviceList: Array<myQDevice> = data.items;

    // Notify the user about any new devices that we've discovered.
    if(newDeviceList) {
      newDeviceList.forEach((newDevice: myQDevice) => {

        if(this.Devices) {
          // We already know about this device.
          if(this.Devices.find((x: myQDevice) => x.serial_number === newDevice.serial_number) !== undefined) {
            return;
          }
        }

        // We've discovered a new device.
        this.log("myQ API: Discovered device family %s: %s.",
          newDevice.device_family, this.getDeviceName(newDevice));

        this.debug(util.inspect(newDevice, { colors: true, sorted: true, depth: 3 }));
      });
    }

    // Notify the user about any devices that have disappeared.
    if(this.Devices) {
      this.Devices.forEach((existingDevice: myQDevice) => {
        if(newDeviceList) {
          // This device still is visible.
          if(newDeviceList.find((x: myQDevice) => x.serial_number === existingDevice.serial_number) !== undefined) {
            return;
          }
        }

        // We've had a device disappear.
        this.log("myQ API: Removed device family %s: %s.", existingDevice.device_family, this.getDeviceName(existingDevice));

        this.debug(util.inspect(existingDevice, { colors: true, sorted: true, depth: 3 }));
      });
    }

    // Save the updated list of devices.
    this.Devices = newDeviceList;

    return true;
  }

  // Query the details of a specific myQ device.
  async queryDevice(log: Logging, deviceId: string): Promise<boolean> {
    // Validate and potentially refresh our security token.
    if(!(await this.checkSecurityToken())) {
      return false;
    }

    // Get the list of device information.
    const response = await this.fetch(myQApiInfo.deviceUrl() + "/Accounts/" + this.accountId + "/devices/" + deviceId, {
      method: "GET",
      headers: this.headers
    });

    if(!response) {
      this.log("myQ API: Unable to query device status from myQ servers. Acquiring a new security token and retrying later.");
      this.securityTokenTimestamp = 0;
      return false;
    }

    // Now let's get our account information.
    const data = await response.json();

    if(!data || !data.items) {
      log("myQ API: error querying device: %s.", deviceId);
      return false;
    }

    this.debug(util.inspect(data, { colors: true, sorted: true, depth: 3 }));

    data.items.forEach((device: myQDevice) => {
      this.debug("Device:");
      this.debug(util.inspect(device, { colors: true, sorted: true, depth: 2 }));
    });

    return true;
  }

  // Execute an action on a myQ device.
  async execute(deviceId: string, command: string): Promise<boolean> {
    // Validate and potentially refresh our security token.
    if(!(await this.checkSecurityToken())) {
      return false;
    }

    const response = await this.fetch(myQApiInfo.deviceUrl() + "/Accounts/" + this.accountId + "/Devices/" + deviceId + "/actions", {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify({ action_type: command })
    });

    if(!response) {
      this.log("myQ API: Unable to send the command to myQ servers. Acquiring a new security token.");
      this.securityTokenTimestamp = 0;
      return false;
    }

    return true;
  }

  // Get the details of a specific device in the myQ device list.
  getDevice(hap: HAP, uuid: string): myQDevice {
    let device: myQDevice;
    const now = Date.now();

    // Check to make sure we have fresh information from myQ. If it's less than a minute
    // old, it looks good to us.
    if(!this.Devices || !this.lastRefreshDevicesCall || ((now - this.lastRefreshDevicesCall) > (60 * 1000))) {
      return null as unknown as myQDevice;
    }

    // Iterate through the list and find the device that matches the UUID we seek.
    // This works because homebridge always generates the same UUID for a given input -
    // in this case the device serial number.
    if((device = this.Devices.find(
      (x: myQDevice) =>
        x.device_family &&
        (x.device_family.indexOf("garagedoor") !== -1) &&
        x.serial_number &&
        (hap.uuid.generate(x.serial_number) === uuid)
    )!) !== undefined) {
      return device;
    }

    return null as unknown as myQDevice;
  }

  // Utility to generate a nicely formatted device string.
  getDeviceName(device: myQDevice): string {

    // A completely enumerated device will appear as:
    // DeviceName [DeviceBrand] (serial number: Serial, gateway: GatewaySerial).
    let deviceString = device.name;
    const hwInfo = this.getHwInfo(device.serial_number);

    if(hwInfo) {
      deviceString += " [" + hwInfo.brand + " " + hwInfo.product + "]";
    }

    if(device.serial_number) {
      deviceString += " (serial number: " + device.serial_number;

      if(device.parent_device_id) {
        deviceString += ", gateway: " + device.parent_device_id;
      }

      deviceString += ")";
    }

    return deviceString;
  }

  // Return device manufacturer and model information based on the serial number, if we can.
  getHwInfo(serial: string): myQHwInfo {

    // We only know about gateway devices and not individual openers, so we can only decode those.
    // According to Liftmaster, here's how you can decode what device you're using:
    //
    // The MyQ serial number for the Wi-Fi GDO, MyQ Home Bridge, MyQ Smart Garage Hub,
    // MyQ Garage (Wi-Fi Hub) and Internet Gateway is 12 characters long. The first two characters,
    // typically "GW", followed by 2 characters that are decoded according to the table below to
    // identify the device type and brand, with the remaining 8 characters representing the serial number.
    const HwInfo: {[index: string]: myQHwInfo} = {
      "00": { product: "Ethernet Gateway",          brand: "Chamberlain" },
      "01": { product: "Ethernet Gateway",          brand: "Liftmaster" },
      "02": { product: "Ethernet Gateway",          brand: "Craftsman" },
      "03": { product: "WiFi Hub",                  brand: "Chamberlain" },
      "04": { product: "WiFi Hub",                  brand: "Liftmaster" },
      "05": { product: "WiFi Hub",                  brand: "Craftsman" },
      "0A": { product: "WiFi GDO AC",               brand: "Chamberlain" },
      "0B": { product: "WiFi GDO AC",               brand: "Liftmaster" },
      "0C": { product: "WiFi GDO AC",               brand: "Craftsman" },
      "0D": { product: "WiFi GDO AC",               brand: "myQ Replacement Logic Board" },
      "0E": { product: "WiFi GDO AC 3/4 HP",        brand: "Chamberlain" },
      "0F": { product: "WiFi GDO AC 3/4 HP",        brand: "Liftmaster" },
      "10": { product: "WiFi GDO AC 3/4 HP",        brand: "Craftsman" },
      "11": { product: "WiFi GDO AC 3/4 HP",        brand: "myQ Replacement Logic Board" },
      "12": { product: "WiFi GDO DC 1.25 HP",       brand: "Chamberlain" },
      "13": { product: "WiFi GDO DC 1.25 HP",       brand: "Liftmaster" },
      "14": { product: "WiFi GDO DC 1.25 HP",       brand: "Craftsman" },
      "15": { product: "WiFi GDO DC 1.25 HP",       brand: "myQ Replacement Logic Board" },
      "20": { product: "myQ Home Bridge",           brand: "Chamberlain" },
      "21": { product: "myQ Home Bridge",           brand: "Liftmaster" },
      "23": { product: "Smart Garage Hub",          brand: "Chamberlain" },
      "24": { product: "Smart Garage Hub",          brand: "Liftmaster" },
      "27": { product: "WiFi Wall Mount Opener",    brand: "Liftmaster" },
      "28": { product: "WiFi Wall Mount Operator",  brand: "Liftmaster Commercial" },
      "80": { product: "Ethernet Gateway",          brand: "Liftmaster EU" },
      "81": { product: "Ethernet Gateway",          brand: "Chamberlain EU" }
    };

    if(!serial || (serial.length < 4)) {
      return undefined as unknown as myQHwInfo;
    }

    // Use the third and fourth characters as indices into the hardware matrix. Admittedly,
    // we don't have a way to resolve the first two characters to ensure we are matching
    // against the right category of devices.
    return HwInfo[serial[2] + serial[3]];
  }

  // Utility to let us streamline error handling and return checking from the myQ API.
  private async fetch(url: RequestInfo, options: RequestInit): Promise<Response> {
    let response: Response;

    try {
      response = await fetch(url, options);

      // Bad username and password.
      if(response.status === 401) {
        this.log("myQ API: Invalid myQ credentials given. Check your login and password.");
        return null as unknown as Promise<Response>;
      }

      // Some other unknown error occurred.
      if(!response.ok) {
        this.log("myQ API: Error: %s %s", response.status, response.statusText);
        return null as unknown as Promise<Response>;
      }

      return response;
    } catch(error) {
      this.log.error(error);
      return null as unknown as Promise<Response>;
    }
  }

  // Utility for debug logging.
  private debug(message: string, ...parameters: any[]) {
    if(debugMode) {
      this.log(util.format(message, ...parameters));
    }
  }
}
