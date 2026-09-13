/**
 * teamColors.js
 *
 * Real team colors (factual, not copyrightable) for the Games Board -
 * NOT logos or artwork. Unknown teams still display fine, just with a
 * neutral badge color, so coverage gaps never hide a game.
 *
 * NFL only for now; add more leagues the same way as you use them.
 */

export const NFL_COLORS = {
  "arizona cardinals": "#97233F", "atlanta falcons": "#A71930", "baltimore ravens": "#241773",
  "buffalo bills": "#00338D", "carolina panthers": "#0085CA", "chicago bears": "#0B162A",
  "cincinnati bengals": "#FB4F14", "cleveland browns": "#311D00", "dallas cowboys": "#041E42",
  "denver broncos": "#FB4F14", "detroit lions": "#0076B6", "green bay packers": "#203731",
  "houston texans": "#03202F", "indianapolis colts": "#002C5F", "jacksonville jaguars": "#101820",
  "kansas city chiefs": "#E31837", "las vegas raiders": "#000000", "los angeles chargers": "#0080C6",
  "los angeles rams": "#003594", "miami dolphins": "#008E97", "minnesota vikings": "#4F2683",
  "new england patriots": "#002244", "new orleans saints": "#D3BC8D", "new york giants": "#0B2265",
  "new york jets": "#125740", "philadelphia eagles": "#004C54", "pittsburgh steelers": "#FFB612",
  "san francisco 49ers": "#AA0000", "seattle seahawks": "#002244", "tampa bay buccaneers": "#D50A0A",
  "tennessee titans": "#0C2340", "washington commanders": "#5A1414",
};

export function getTeamColor(teamName) {
  if (!teamName) return "#7c8a99";
  return NFL_COLORS[teamName.toLowerCase().trim()] || "#7c8a99";
}
