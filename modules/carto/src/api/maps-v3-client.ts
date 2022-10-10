/**
 * Maps API Client for Carto 3
 */
import {
  getDefaultCredentials,
  buildMapsUrlFromBase,
  buildStatsUrlFromBase,
  CloudNativeCredentials
} from '../config';
import {
  API_VERSIONS,
  COLUMNS_SUPPORT,
  encodeParameter,
  Format,
  FORMATS,
  GEO_COLUMN_SUPPORT,
  MapInstantiation,
  MapType,
  MAP_TYPES,
  QueryParameters,
  SchemaField,
  TileFormat,
  TILE_FORMATS
} from './maps-api-common';
import {parseMap} from './parseMap';
import {log} from '@deck.gl/core';
import {assert} from '../utils';

const MAX_GET_LENGTH = 2048;
const DEFAULT_CLIENT = 'deck-gl-carto';
const V3_MINOR_VERSION = '3.1';

export type Headers = Record<string, string>;
interface RequestParams {
  method?: string;
  url: string;
  headers?: Headers;
  accessToken?: string;
  body?: any;
}

/**
 * Request against Maps API
 */
async function request({
  method,
  url,
  headers: customHeaders,
  accessToken,
  body
}: RequestParams): Promise<Response> {
  const headers: Headers = {
    ...customHeaders,
    Accept: 'application/json'
  };

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
  }

  try {
    /* global fetch */
    return await fetch(url, {
      method,
      headers,
      body
    });
  } catch (error) {
    throw new Error(`Failed to connect to Maps API: ${error}`);
  }
}

async function requestJson<T = unknown>({
  method,
  url,
  headers,
  accessToken,
  body
}: RequestParams): Promise<T> {
  const response = await request({method, url, headers, accessToken, body});
  const json = await response.json();

  if (!response.ok) {
    dealWithError({response, error: json.error});
  }
  return json as T;
}

async function requestData({
  method,
  url,
  accessToken,
  format,
  body
}: RequestParams & {
  format: Format;
}): Promise<Response | unknown> {
  if (format === FORMATS.NDJSON) {
    return request({method, url, accessToken, body});
  }

  const data = await requestJson<any>({method, url, accessToken, body});
  return data.rows ? data.rows : data;
}

/**
 * Display proper message from Maps API error
 */
function dealWithError({response, error}: {response: Response; error?: string}): never {
  switch (response.status) {
    case 400:
      throw new Error(`Bad request. ${error}`);
    case 401:
    case 403:
      throw new Error(`Unauthorized access. ${error}`);
    default:
      throw new Error(error);
  }
}

type FetchLayerDataParams = {
  type: MapType;
  source: string;
  connection: string;
  credentials: CloudNativeCredentials;
  geoColumn?: string;
  columns?: string[];
  clientId?: string;
  format?: Format;
  formatTiles?: TileFormat;
  headers?: Headers;
  aggregationExp?: string;
  aggregationResLevel?: number;
  queryParameters?: QueryParameters;
};

/**
 * Build a URL with all required parameters
 */
function getParameters({
  type,
  source,
  geoColumn,
  columns,
  clientId,
  aggregationExp,
  aggregationResLevel,
  queryParameters
}: Omit<FetchLayerDataParams, 'connection' | 'credentials'>) {
  const parameters = [encodeParameter('client', clientId || DEFAULT_CLIENT)];
  parameters.push(encodeParameter('v', V3_MINOR_VERSION));

  const sourceName = type === MAP_TYPES.QUERY ? 'q' : 'name';
  parameters.push(encodeParameter(sourceName, source));

  if (queryParameters) {
    parameters.push(encodeParameter('queryParameters', JSON.stringify(queryParameters)));
  }

  if (geoColumn) {
    parameters.push(encodeParameter('geo_column', geoColumn));
  }
  if (columns) {
    parameters.push(encodeParameter('columns', columns.join(',')));
  }
  if (aggregationExp) {
    parameters.push(encodeParameter('aggregationExp', aggregationExp));
  } else if (isSpatialIndexGeoColumn(geoColumn)) {
    // Default aggregationExp required for spatial index layers
    parameters.push(encodeParameter('aggregationExp', '1 AS value'));
  }
  if (aggregationResLevel) {
    parameters.push(encodeParameter('aggregationResLevel', aggregationResLevel));
  }

  return parameters.join('&');
}

function isSpatialIndexGeoColumn(geoColumn: string | undefined) {
  const spatialIndex = geoColumn?.split(':')[0];
  return spatialIndex === 'h3' || spatialIndex === 'quadbin';
}

export async function mapInstantiation({
  type,
  source,
  connection,
  credentials,
  geoColumn,
  columns,
  clientId,
  headers,
  aggregationExp,
  aggregationResLevel,
  queryParameters
}: FetchLayerDataParams): Promise<MapInstantiation> {
  const baseUrl = `${credentials.mapsUrl}/${connection}/${type}`;
  const url = `${baseUrl}?${getParameters({
    type,
    source,
    geoColumn,
    columns,
    clientId,
    aggregationResLevel,
    aggregationExp,
    queryParameters
  })}`;
  const {accessToken} = credentials;

  if (url.length > MAX_GET_LENGTH && type === MAP_TYPES.QUERY) {
    // need to be a POST request
    const body = JSON.stringify({
      q: source,
      client: clientId || DEFAULT_CLIENT,
      queryParameters
    });
    return await requestJson({method: 'POST', url: baseUrl, headers, accessToken, body});
  }

  return await requestJson({url, headers, accessToken});
}

function getUrlFromMetadata(metadata: MapInstantiation, format: Format): string | null {
  const m = metadata[format];

  if (m && !m.error && m.url) {
    return m.url[0];
  }

  return null;
}

function checkFetchLayerDataParameters({
  type,
  source,
  connection,
  credentials,
  geoColumn,
  columns,
  aggregationExp,
  aggregationResLevel
}: FetchLayerDataParams) {
  assert(connection, 'Must define connection');
  assert(type, 'Must define a type');
  assert(source, 'Must define a source');

  assert(credentials.apiVersion === API_VERSIONS.V3, 'Method only available for v3');
  assert(credentials.apiBaseUrl, 'Must define apiBaseUrl');
  assert(credentials.accessToken, 'Must define an accessToken');

  if (columns) {
    assert(
      COLUMNS_SUPPORT.includes(type),
      `The columns parameter is not supported by type ${type}`
    );
  }
  if (geoColumn) {
    assert(
      GEO_COLUMN_SUPPORT.includes(type),
      `The geoColumn parameter is not supported by type ${type}`
    );
  } else {
    assert(!aggregationExp, 'Have aggregationExp, but geoColumn parameter is missing');
    assert(!aggregationResLevel, 'Have aggregationResLevel, but geoColumn parameter is missing');
  }

  if (!aggregationExp) {
    assert(
      !aggregationResLevel,
      'Have aggregationResLevel, but aggregationExp parameter is missing'
    );
  }
}

export interface FetchLayerDataResult {
  data: any;
  format?: Format;
  schema: SchemaField[];
}
export async function fetchLayerData({
  type,
  source,
  connection,
  credentials,
  geoColumn,
  columns,
  format,
  formatTiles,
  clientId,
  headers,
  aggregationExp,
  aggregationResLevel,
  queryParameters
}: FetchLayerDataParams): Promise<FetchLayerDataResult> {
  // Internally we split data fetching into two parts to allow us to
  // conditionally fetch the actual data, depending on the metadata state
  const {url, accessToken, mapFormat, metadata} = await _fetchDataUrl({
    type,
    source,
    connection,
    credentials,
    geoColumn,
    columns,
    format,
    formatTiles,
    clientId,
    headers,
    aggregationExp,
    aggregationResLevel,
    queryParameters
  });

  const data = await requestData({url, format: mapFormat, accessToken});
  const result: FetchLayerDataResult = {data, format: mapFormat, schema: metadata.schema};
  return result;
}

async function _fetchDataUrl({
  type,
  source,
  connection,
  credentials,
  geoColumn,
  columns,
  format,
  formatTiles,
  clientId,
  headers,
  aggregationExp,
  aggregationResLevel,
  queryParameters
}: FetchLayerDataParams) {
  const defaultCredentials = getDefaultCredentials();
  // Only pick up default credentials if they have been defined for
  // correct API version
  const localCreds = {
    ...(defaultCredentials.apiVersion === API_VERSIONS.V3 && defaultCredentials),
    ...credentials
  };
  checkFetchLayerDataParameters({
    type,
    source,
    connection,
    credentials: localCreds,
    geoColumn,
    columns,
    aggregationExp,
    aggregationResLevel
  });

  if (!localCreds.mapsUrl) {
    localCreds.mapsUrl = buildMapsUrlFromBase(localCreds.apiBaseUrl);
  }

  const metadata = await mapInstantiation({
    type,
    source,
    connection,
    credentials: localCreds,
    geoColumn,
    columns,
    clientId,
    headers,
    aggregationExp,
    aggregationResLevel,
    queryParameters
  });
  let url: string | null = null;
  let mapFormat: Format | undefined;

  if (format) {
    mapFormat = format;
    url = getUrlFromMetadata(metadata, format);
    assert(url, `Format ${format} not available`);
  } else {
    // guess map format
    const prioritizedFormats = [FORMATS.GEOJSON, FORMATS.JSON, FORMATS.NDJSON, FORMATS.TILEJSON];
    for (const f of prioritizedFormats) {
      url = getUrlFromMetadata(metadata, f);
      if (url) {
        mapFormat = f;
        break;
      }
    }
    assert(url && mapFormat, 'Unsupported data formats received from backend.');
  }

  if (format === FORMATS.TILEJSON && formatTiles) {
    log.assert(
      Object.values(TILE_FORMATS).includes(formatTiles),
      `Invalid value for formatTiles: ${formatTiles}. Use value from TILE_FORMATS`
    );
    url += `&${encodeParameter('formatTiles', formatTiles)}`;
  }

  const {accessToken} = localCreds;
  return {url, accessToken, mapFormat, metadata};
}

/* global clearInterval, setInterval, URL */
async function _fetchMapDataset(
  dataset,
  accessToken: string,
  credentials: CloudNativeCredentials,
  clientId?: string,
  headers?: Headers
) {
  const {
    aggregationExp,
    aggregationResLevel,
    connectionName: connection,
    columns,
    format,
    geoColumn,
    source,
    type,
    queryParameters
  } = dataset;
  // First fetch metadata
  const {url, mapFormat} = await _fetchDataUrl({
    aggregationExp,
    aggregationResLevel,
    clientId,
    credentials: {...credentials, accessToken},
    connection,
    columns,
    format,
    geoColumn,
    headers,
    source,
    type,
    queryParameters
  });

  // Extract the last time the data changed
  const cache = parseInt(new URL(url).searchParams.get('cache') || '', 10);
  if (cache && dataset.cache === cache) {
    return false;
  }
  dataset.cache = cache;

  // Only fetch if the data has changed
  dataset.data = await requestData({url, format: mapFormat, accessToken});

  return true;
}

async function _fetchTilestats(
  attribute,
  dataset,
  accessToken: string,
  credentials: CloudNativeCredentials
) {
  const {connectionName: connection, source, type} = dataset;

  const statsUrl = buildStatsUrlFromBase(credentials.apiBaseUrl);
  let url = `${statsUrl}/${connection}/`;
  if (type === MAP_TYPES.QUERY) {
    url += `${attribute}?${encodeParameter('q', source)}`;
  } else {
    // MAP_TYPE.TABLE
    url += `${source}/${attribute}`;
  }
  const stats = await requestData({url, format: FORMATS.JSON, accessToken});

  // Replace tilestats for attribute with value from API
  const {attributes} = dataset.data.tilestats.layers[0];
  const index = attributes.findIndex(d => d.attribute === attribute);
  attributes[index] = stats;
  return true;
}

async function fillInMapDatasets(
  {datasets, token},
  clientId: string,
  credentials: CloudNativeCredentials,
  headers?: Headers
) {
  const promises = datasets.map(dataset =>
    _fetchMapDataset(dataset, token, credentials, clientId, headers)
  );
  return await Promise.all(promises);
}

async function fillInTileStats(
  {datasets, keplerMapConfig, token},
  credentials: CloudNativeCredentials
) {
  const attributes: {attribute?: string; dataset?: any}[] = [];
  const {layers} = keplerMapConfig.config.visState;
  for (const layer of layers) {
    for (const channel of Object.keys(layer.visualChannels)) {
      const attribute = layer.visualChannels[channel]?.name;
      if (attribute) {
        const dataset = datasets.find(d => d.id === layer.config.dataId);
        if (dataset.data.tilestats && dataset.type !== MAP_TYPES.TILESET) {
          // Only fetch stats for QUERY & TABLE map types
          attributes.push({attribute, dataset});
        }
      }
    }
  }
  // Remove duplicates to avoid repeated requests
  const filteredAttributes: {attribute?: string; dataset?: any}[] = [];
  for (const a of attributes) {
    if (
      !filteredAttributes.find(
        ({attribute, dataset}) => attribute === a.attribute && dataset === a.dataset
      )
    ) {
      filteredAttributes.push(a);
    }
  }

  const promises = filteredAttributes.map(({attribute, dataset}) =>
    _fetchTilestats(attribute, dataset, token, credentials)
  );
  return await Promise.all(promises);
}

export async function fetchMap({
  cartoMapId,
  clientId,
  credentials,
  headers,
  autoRefresh,
  onNewData
}: {
  cartoMapId: string;
  clientId: string;
  credentials?: CloudNativeCredentials;
  headers?: Headers;
  autoRefresh?: number;
  onNewData?: (map: any) => void;
}) {
  const defaultCredentials = getDefaultCredentials();
  const localCreds = {
    ...(defaultCredentials.apiVersion === API_VERSIONS.V3 && defaultCredentials),
    ...credentials
  } as CloudNativeCredentials;
  const {accessToken} = localCreds;

  assert(cartoMapId, 'Must define CARTO map id: fetchMap({cartoMapId: "XXXX-XXXX-XXXX"})');

  assert(localCreds.apiVersion === API_VERSIONS.V3, 'Method only available for v3');
  assert(localCreds.apiBaseUrl, 'Must define apiBaseUrl');
  if (!localCreds.mapsUrl) {
    localCreds.mapsUrl = buildMapsUrlFromBase(localCreds.apiBaseUrl);
  }

  if (autoRefresh || onNewData) {
    assert(onNewData, 'Must define `onNewData` when using autoRefresh');
    assert(typeof onNewData === 'function', '`onNewData` must be a function');
    assert(
      typeof autoRefresh === 'number' && autoRefresh > 0,
      '`autoRefresh` must be a positive number'
    );
  }

  const url = `${localCreds.mapsUrl}/public/${cartoMapId}`;
  const map = await requestJson<any>({url, headers, accessToken});

  // Periodically check if the data has changed. Note that this
  // will not update when a map is published.
  let stopAutoRefresh: (() => void) | undefined;
  if (autoRefresh) {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    const intervalId = setInterval(async () => {
      const changed = await fillInMapDatasets(map, clientId, localCreds, headers);
      if (onNewData && changed.some(v => v === true)) {
        onNewData(parseMap(map));
      }
    }, autoRefresh * 1000);
    stopAutoRefresh = () => {
      clearInterval(intervalId);
    };
  }

  const geojsonLayers = map.keplerMapConfig.config.visState.layers.filter(
    ({type}) => type === 'geojson' || type === 'point'
  );
  const geojsonDatasetIds = geojsonLayers.map(({config}) => config.dataId);
  map.datasets.forEach(dataset => {
    if (geojsonDatasetIds.includes(dataset.id)) {
      dataset.format = 'geojson';
    }
  });

  // Mutates map.datasets so that dataset.data contains data
  await fillInMapDatasets(map, clientId, localCreds, headers);

  // Mutates attributes in visualChannels to contain tile stats
  await fillInTileStats(map, localCreds);
  return {
    ...parseMap(map),
    ...{stopAutoRefresh}
  };
}
