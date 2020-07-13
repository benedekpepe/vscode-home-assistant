import * as ha from "home-assistant-js-websocket";
import {
  CompletionItem,
  CompletionItemKind,
  MarkupContent,
} from "vscode-languageserver-protocol";
import { IConfigurationService } from "../configuration";
import { createSocket } from "./socket";

// eslint-disable-next-line @typescript-eslint/no-var-requires, import/no-extraneous-dependencies
const rp = require("request-promise");

export interface IHaConnection {
  tryConnect(): Promise<void>;
  notifyConfigUpdate(conf: any): Promise<void>;
  getEntityCompletions(): Promise<CompletionItem[]>;
  getServiceCompletions(): Promise<CompletionItem[]>;
}

export class HaConnection implements IHaConnection {
  private connection: ha.Connection | undefined;

  private hassEntities!: Promise<ha.HassEntities>;

  private hassServices!: Promise<ha.HassServices>;

  constructor(private configurationService: IConfigurationService) {}

  public tryConnect = async (): Promise<void> => {
    await this.createConnection();
  };

  private async createConnection(): Promise<void> {
    if (!this.configurationService.isConfigured) {
      return;
    }

    if (this.connection !== undefined) {
      return;
    }

    const auth = new ha.Auth(<ha.AuthData>{
      access_token: `${this.configurationService.token}`,
      expires: +new Date(new Date().getTime() + 1e11),
      hassUrl: `${this.configurationService.url}`,
      clientId: "",
      expires_in: +new Date(new Date().getTime() + 1e11),
      refresh_token: "",
    });

    try {
      console.log("Connecting to Home Assistant...");
      this.connection = await ha.createConnection({
        auth,
        createSocket: async () =>
          createSocket(auth, this.configurationService.ignoreCertificates),
      });
      console.log("Connected to Home Assistant");
    } catch (error) {
      this.handleConnectionError(error);
      throw error;
    }

    this.connection.addEventListener("ready", () => {
      console.log("(re-)connected to Home Assistant");
    });

    this.connection.addEventListener("disconnected", () => {
      console.warn("Lost connection with Home Assistant");
    });

    this.connection.addEventListener("reconnect-error", (data) => {
      console.error("Reconnect error with Home Assistant", data);
    });
  }

  private handleConnectionError = (error: any) => {
    this.connection = undefined;
    const tokenIndication = `${this.configurationService.token}`.substring(
      0,
      5
    );
    let errorText = error;
    switch (error) {
      case 1:
        errorText = "ERR_CANNOT_CONNECT";
        break;
      case 2:
        errorText = "ERR_INVALID_AUTH";
        break;
      case 3:
        errorText = "ERR_CONNECTION_LOST";
        break;
      case 4:
        errorText = "ERR_HASS_HOST_REQUIRED";
        break;
    }
    const message = `Error connecting to your Home Assistant Server at ${this.configurationService.url} and token '${tokenIndication}...', check your network or update your VS Code Settings, make sure to (also) check your workspace settings! Error: ${errorText}`;
    console.error(message);
  };

  public notifyConfigUpdate = async (): Promise<void> => {
    this.disconnect();
    try {
      await this.tryConnect();
    } catch (err) {
      // so be it, error is now displayed in logs
    }
  };

  private getHassEntities = async (): Promise<ha.HassEntities> => {
    if (this.hassEntities !== undefined) {
      return this.hassEntities;
    }

    await this.createConnection();
    this.hassEntities = new Promise<ha.HassEntities>(
      // eslint-disable-next-line @typescript-eslint/require-await, no-async-promise-executor, consistent-return
      async (resolve, reject) => {
        if (!this.connection) {
          return reject();
        }
        ha.subscribeEntities(this.connection, (entities) => {
          console.log(
            `Got ${Object.keys(entities).length} entities from Home Assistant`
          );
          return resolve(entities);
        });
      }
    );
    return this.hassEntities;
  };

  public async getEntityCompletions(): Promise<CompletionItem[]> {
    const entities = await this.getHassEntities();

    if (!entities) {
      return [];
    }

    const completions: CompletionItem[] = [];

    for (const [, value] of Object.entries(entities)) {
      const completionItem = CompletionItem.create(`${value.entity_id}`);
      completionItem.detail = value.attributes.friendly_name;
      completionItem.kind = CompletionItemKind.Variable;
      completionItem.filterText = `${value.entity_id} ${value.attributes.friendly_name}`;
      completionItem.insertText = value.entity_id;
      completionItem.data = {};
      completionItem.data.isEntity = true;

      completionItem.documentation = <MarkupContent>{
        kind: "markdown",
        value: `**${value.entity_id}** \r\n \r\n`,
      };

      if (value.state) {
        completionItem.documentation.value += `State: ${value.state} \r\n \r\n`;
      }
      completionItem.documentation.value += `| Attribute | Value | \r\n`;
      completionItem.documentation.value += `| :---- | :---- | \r\n`;

      for (const [attrKey, attrValue] of Object.entries(value.attributes)) {
        completionItem.documentation.value += `| ${attrKey} | ${attrValue} | \r\n`;
      }
      completions.push(completionItem);
    }
    return completions;
  }

  private getHassServices = async (): Promise<ha.HassServices> => {
    await this.createConnection();

    if (!this.hassServices) {
      this.hassServices = new Promise<ha.HassServices>(
        // eslint-disable-next-line @typescript-eslint/require-await, no-async-promise-executor, consistent-return
        async (resolve, reject) => {
          if (!this.connection) {
            return reject();
          }
          ha.subscribeServices(this.connection, (services) => {
            console.log(
              `Got ${Object.keys(services).length} services from Home Assistant`
            );
            return resolve(services);
          });
        }
      );
    }
    return this.hassServices;
  };

  public async getServiceCompletions(): Promise<CompletionItem[]> {
    const services = await this.getHassServices();

    if (!services) {
      return [];
    }

    const completions: CompletionItem[] = [];

    for (const [domainKey, domainValue] of Object.entries(services)) {
      for (const [serviceKey, serviceValue] of Object.entries(domainValue)) {
        const completionItem = CompletionItem.create(
          `${domainKey}.${serviceKey}`
        );
        completionItem.kind = CompletionItemKind.EnumMember;
        completionItem.filterText = `${domainKey}.${serviceKey}`;
        completionItem.insertText = completionItem.filterText;
        completionItem.data = {};
        completionItem.data.isService = true;

        const fields = Object.entries(serviceValue.fields);

        if (fields.length > 0) {
          completionItem.documentation = <MarkupContent>{
            kind: "markdown",
            value: `**${domainKey}.${serviceKey}:** \r\n \r\n`,
          };

          completionItem.documentation.value += `| Field | Description | Example | \r\n`;
          completionItem.documentation.value += `| :---- | :---- | :---- | \r\n`;

          for (const [fieldKey, fieldValue] of fields) {
            completionItem.documentation.value += `| ${fieldKey} | ${fieldValue.description} |  ${fieldValue.example} | \r\n`;
          }
        }
        completions.push(completionItem);
      }
    }

    return completions;
  }

  public disconnect(): void {
    if (!this.connection) {
      return;
    }
    console.log(`Disconnecting from Home Assistant`);
    this.connection.close();
    this.connection = undefined;
  }

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  public callApi = (method: string, api: string, requestBody?: any): string => {
    const options = {
      method,
      url: `${this.configurationService.url}/api/${api}`,
      headers: {
        Authorization: `Bearer ${this.configurationService.token}`,
      },
      body: requestBody,
      json: true,
    };

    function callback(error: any, response: any, body: any) {
      if (!error && response.statusCode === 200) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return body;
      }
      console.error("HA Api Call request failed!", error);
      return "";
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
    return rp(options, callback);
  };

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  public callService(domain: string, service: string, serviceData: any): any {
    // over websockets (no response)
    // callService(this.connection, domain, service, serviceData);

    const options = {
      method: "POST",
      url: `${this.configurationService.url}/api/services/${domain}/${service}`,
      headers: {
        Authorization: `Bearer ${this.configurationService.token}`,
      },
      body: serviceData,
      json: true,
    };

    function callback(error: any, response: any, body: any) {
      if (!error && response.statusCode === 200) {
        console.log(
          `Service Call ${domain}.${service} made succesfully, response:`
        );
        console.log(body);
      } else {
        console.error(error);
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
    return rp(options, callback);
  }
}