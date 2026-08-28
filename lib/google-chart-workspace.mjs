export const REDESIGN_PALETTE = Object.freeze({
  navy: "#2A3981",
  yellow: "#FCC51E",
  coral: "#D26868",
  green: "#3C9276",
  blue: "#506DFF",
  gray: "#9D9E9E",
  black: "#000000",
  white: "#FFFFFF"
});

const PALETTE = [
  REDESIGN_PALETTE.navy,
  REDESIGN_PALETTE.yellow,
  REDESIGN_PALETTE.coral,
  REDESIGN_PALETTE.green,
  REDESIGN_PALETTE.blue
];

function rgb(hex) {
  const value = hex.replace("#", "");
  return {
    red: parseInt(value.slice(0, 2), 16) / 255,
    green: parseInt(value.slice(2, 4), 16) / 255,
    blue: parseInt(value.slice(4, 6), 16) / 255
  };
}

function range(sheetId, column, rowCount) {
  return {
    sources: [{
      sheetId,
      startRowIndex: 0,
      endRowIndex: Math.max(2, rowCount),
      startColumnIndex: column,
      endColumnIndex: column + 1
    }]
  };
}

function textFormat({ color = REDESIGN_PALETTE.black, fontSize = 12, bold = false } = {}) {
  return {
    foregroundColorStyle: { rgbColor: rgb(color) },
    fontFamily: "Arial",
    fontSize,
    bold
  };
}

function axis(position, title, viewWindowOptions) {
  const result = { position };
  if (title) result.title = title;
  if (position !== "BOTTOM_AXIS") result.format = textFormat({ color: REDESIGN_PALETTE.black, fontSize: 11 });
  if (viewWindowOptions) result.viewWindowOptions = { viewWindowMode: "EXPLICIT", ...viewWindowOptions };
  return result;
}

function seriesColor(definition, index) {
  return definition.colors?.[index] || PALETTE[index % PALETTE.length];
}

function dataLabel(definition, index, seriesType) {
  if (definition.showDataLabels === false || definition.seriesDataLabels?.[index] === false) return { type: "NONE" };
  const isLine = definition.type === "LINE" || definition.type === "SCATTER" || seriesType === "LINE";
  const placement = definition.labelPlacements?.[index] || (isLine ? "ABOVE" : "OUTSIDE_END");
  return {
    type: "DATA",
    placement,
    textFormat: textFormat({
      color: definition.labelColors?.[index] || REDESIGN_PALETTE.black,
      fontSize: definition.dataLabelSize || 11,
      bold: true
    })
  };
}

export function chartSpec(definition, sheetId) {
  const rowCount = definition.values.length;
  const common = {
    title: definition.title,
    fontName: "Arial",
    titleTextFormat: textFormat({ color: REDESIGN_PALETTE.navy, fontSize: definition.titleSize || 22, bold: true }),
    titleTextPosition: { horizontalAlignment: "CENTER" },
    backgroundColorStyle: { rgbColor: rgb(REDESIGN_PALETTE.white) },
    maximized: definition.maximized === true,
    hiddenDimensionStrategy: "SHOW_ALL"
  };
  if (definition.type === "PIE") {
    return {
      ...common,
      pieChart: {
        legendPosition: definition.legendPosition || "RIGHT_LEGEND",
        domain: { sourceRange: range(sheetId, 0, rowCount) },
        series: { sourceRange: range(sheetId, 1, rowCount) },
        threeDimensional: false,
        pieHole: 0
      }
    };
  }
  const series = definition.headers.slice(1).map((_, index) => ({
    ...(() => {
      const seriesType = definition.seriesTypes?.[index];
      const isLine = definition.type === "LINE" || definition.type === "SCATTER" || seriesType === "LINE";
      return {
        series: { sourceRange: range(sheetId, index + 1, rowCount) },
        targetAxis: definition.secondary?.includes(index + 1) ? "RIGHT_AXIS" : "LEFT_AXIS",
        type: seriesType || undefined,
        colorStyle: { rgbColor: rgb(seriesColor(definition, index)) },
        dataLabel: dataLabel(definition, index, seriesType),
        ...(isLine ? {
          lineStyle: {
            width: definition.lineWidths?.[index] || 3,
            type: definition.type === "SCATTER" && definition.connectPoints !== true ? "INVISIBLE" : "SOLID"
          },
          pointStyle: { size: definition.pointSizes?.[index] || 7, shape: "CIRCLE" }
        } : {})
      };
    })()
  }));
  const leftView = definition.leftMin === undefined && definition.leftMax === undefined ? null : {
    ...(definition.leftMin === undefined ? {} : { viewWindowMin: definition.leftMin }),
    ...(definition.leftMax === undefined ? {} : { viewWindowMax: definition.leftMax })
  };
  const rightView = definition.rightMin === undefined && definition.rightMax === undefined ? null : {
    ...(definition.rightMin === undefined ? {} : { viewWindowMin: definition.rightMin }),
    ...(definition.rightMax === undefined ? {} : { viewWindowMax: definition.rightMax })
  };
  const basicChart = {
    chartType: definition.type,
    legendPosition: definition.legendPosition || "TOP_LEGEND",
    headerCount: 1,
    domains: [{ domain: { sourceRange: range(sheetId, 0, rowCount) } }],
    series,
    axis: [
      axis("BOTTOM_AXIS", definition.horizontalTitle || ""),
      axis("LEFT_AXIS", definition.verticalTitle || "", leftView),
      ...(definition.secondary?.length ? [axis("RIGHT_AXIS", definition.secondaryTitle || "", rightView)] : [])
    ],
    interpolateNulls: false,
    lineSmoothing: false,
    compareMode: "DATUM"
  };
  if (["BAR", "COLUMN", "AREA", "COMBO", "STEPPED_AREA"].includes(definition.type)) {
    basicChart.stackedType = definition.stacked ? "STACKED" : "NOT_STACKED";
  }
  return {
    ...common,
    basicChart
  };
}

function spreadsheetTheme() {
  const colors = [
    ["TEXT", REDESIGN_PALETTE.black],
    ["BACKGROUND", REDESIGN_PALETTE.white],
    ["ACCENT1", REDESIGN_PALETTE.navy],
    ["ACCENT2", REDESIGN_PALETTE.navy],
    ["ACCENT3", REDESIGN_PALETTE.yellow],
    ["ACCENT4", REDESIGN_PALETTE.coral],
    ["ACCENT5", REDESIGN_PALETTE.green],
    ["ACCENT6", REDESIGN_PALETTE.gray],
    ["LINK", REDESIGN_PALETTE.navy]
  ];
  return {
    primaryFontFamily: "Arial",
    themeColors: colors.map(([colorType, value]) => ({ colorType, color: { rgbColor: rgb(value) } }))
  };
}

function numberFormatRequests(definitions) {
  const requests = [];
  for (const [sheetIndex, definition] of definitions.entries()) {
    for (const [column, pattern] of Object.entries(definition.numberFormats || {})) {
      requests.push({
        repeatCell: {
          range: {
            sheetId: 1000 + sheetIndex,
            startRowIndex: 1,
            endRowIndex: Math.max(2, definition.values.length),
            startColumnIndex: Number(column),
            endColumnIndex: Number(column) + 1
          },
          cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern } } },
          fields: "userEnteredFormat.numberFormat"
        }
      });
    }
  }
  return requests;
}

async function googleJson(fetchImpl, url, accessToken, options = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetchImpl(url, {
      ...options,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });
    const data = await response.json();
    if (response.ok) return data;
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
      throw new Error(data?.error?.message || `Google API вернул ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1) ** 2));
  }
}

function quoteSheet(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export async function createChartWorkspace({ accessToken, title, definitions, fetchImpl = fetch }) {
  if (!definitions.length) return null;
  const sheets = definitions.map((definition, index) => ({
    properties: { sheetId: 1000 + index, title: definition.key.slice(0, 80), hidden: index > 0 }
  }));
  const spreadsheet = await googleJson(
    fetchImpl,
    "https://sheets.googleapis.com/v4/spreadsheets?fields=spreadsheetId,sheets.properties",
    accessToken,
    { method: "POST", body: JSON.stringify({ properties: { title, spreadsheetTheme: spreadsheetTheme() }, sheets }) }
  );
  const spreadsheetId = spreadsheet.spreadsheetId;
  await googleJson(
    fetchImpl,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
    accessToken,
    {
      method: "POST",
      body: JSON.stringify({
        valueInputOption: "USER_ENTERED",
        data: definitions.map((definition) => ({
          range: `${quoteSheet(definition.key)}!A1`,
          majorDimension: "ROWS",
          values: definition.values
        }))
      })
    }
  );
  const addChart = await googleJson(
    fetchImpl,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    accessToken,
    {
      method: "POST",
      body: JSON.stringify({
        requests: [
          ...numberFormatRequests(definitions),
          ...definitions.map((definition, index) => ({
          addChart: {
            chart: {
              spec: chartSpec(definition, 1000 + index),
              position: {
                overlayPosition: {
                  anchorCell: { sheetId: 1000 + index, rowIndex: 0, columnIndex: definition.headers.length + 2 },
                  widthPixels: definition.widthPixels || 820,
                  heightPixels: definition.heightPixels || 500
                }
              }
            }
          }
          }))
        ]
      })
    }
  );
  const chartIds = {};
  const chartReplies = (addChart.replies || []).filter((reply) => reply.addChart);
  for (const [index, reply] of chartReplies.entries()) {
    chartIds[definitions[index].key] = reply.addChart.chart.chartId;
  }
  return { spreadsheetId, chartIds };
}

export async function trashChartWorkspace({ accessToken, spreadsheetId, fetchImpl = fetch }) {
  if (!spreadsheetId) return;
  await googleJson(
    fetchImpl,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}?supportsAllDrives=true&fields=id,trashed`,
    accessToken,
    { method: "PATCH", body: JSON.stringify({ trashed: true }) }
  );
}
