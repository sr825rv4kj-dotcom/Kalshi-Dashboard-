/**
 * Team identity: full name, sport emoji, and real team colors.
 *
 * Colors are packed as a single string table rather than a nested object so
 * the file stays short enough to paste on a phone. Format per entry:
 *   league|nickname|primaryHex|secondaryHex
 * Lookup is league-scoped because nicknames collide across leagues (Cardinals,
 * Giants, Rangers, Panthers, Jets, Kings all appear in two).
 */

export const SPORT_EMOJI = {
  americanfootball_nfl: "🏈",
  americanfootball_ncaaf: "🏈",
  basketball_nba: "🏀",
  basketball_ncaab: "🏀",
  basketball_wnba: "🏀",
  baseball_mlb: "⚾",
  icehockey_nhl: "🏒",
  tennis: "🎾",
  soccer: "⚽",
  golf: "⛳",
  mma_mixed_martial_arts: "🥊",
  boxing: "🥊",
  motorsport_nascar: "🏁",
};

export const SPORT_LABEL = {
  americanfootball_nfl: "NFL",
  americanfootball_ncaaf: "NCAA Football",
  basketball_nba: "NBA",
  basketball_ncaab: "NCAA Basketball",
  basketball_wnba: "WNBA",
  baseball_mlb: "MLB",
  icehockey_nhl: "NHL",
};

const LEAGUE_OF = {
  americanfootball_nfl: "nfl",
  basketball_nba: "nba",
  baseball_mlb: "mlb",
  icehockey_nhl: "nhl",
};

const TABLE = `
nba|hawks|E03A3E|C1D32F nba|celtics|007A33|BA9653 nba|nets|000000|777777 nba|hornets|1D1160|00788C
nba|bulls|CE1141|000000 nba|cavaliers|860038|FDBB30 nba|mavericks|00538C|002B5E nba|nuggets|0E2240|FEC524
nba|pistons|C8102E|1D42BA nba|warriors|1D428A|FFC72C nba|rockets|CE1141|000000 nba|pacers|002D62|FDBB30
nba|clippers|C8102E|1D428A nba|lakers|552583|FDB927 nba|grizzlies|5D76A9|12173F nba|heat|98002E|F9A01B
nba|bucks|00471B|EEE1C6 nba|timberwolves|0C2340|236192 nba|pelicans|0C2340|C8102E nba|knicks|006BB6|F58426
nba|thunder|007AC1|EF3B24 nba|magic|0077C0|C4CED4 nba|76ers|006BB6|ED174C nba|suns|1D1160|E56020
nba|blazers|E03A3E|000000 nba|kings|5A2D81|63727A nba|spurs|8A8D8F|000000 nba|raptors|CE1141|000000
nba|jazz|002B5C|00471B nba|wizards|002B5C|E31837
nfl|cardinals|97233F|000000 nfl|falcons|A71930|000000 nfl|ravens|241773|9E7C0C nfl|bills|00338D|C60C30
nfl|panthers|0085CA|101820 nfl|bears|0B162A|C83803 nfl|bengals|FB4F14|000000 nfl|browns|311D00|FF3C00
nfl|cowboys|003594|869397 nfl|broncos|FB4F14|002244 nfl|lions|0076B6|B0B7BC nfl|packers|203731|FFB612
nfl|texans|03202F|A71930 nfl|colts|002C5F|A2AAAD nfl|jaguars|101820|D7A22A nfl|chiefs|E31837|FFB81C
nfl|raiders|000000|A5ACAF nfl|chargers|0080C6|FFC20E nfl|rams|003594|FFA300 nfl|dolphins|008E97|FC4C02
nfl|vikings|4F2683|FFC62F nfl|patriots|002244|C60C30 nfl|saints|D3BC8D|101820 nfl|giants|0B2265|A71930
nfl|jets|125740|FFFFFF nfl|eagles|004C54|A5ACAF nfl|steelers|FFB612|101820 nfl|49ers|AA0000|B3995D
nfl|seahawks|002244|69BE28 nfl|buccaneers|D50A0A|34302B nfl|titans|0C2340|4B92DB nfl|commanders|5A1414|FFB612
mlb|diamondbacks|A71930|E3D4AD mlb|braves|CE1141|13274F mlb|orioles|DF4601|000000 mlb|sox|BD3039|0C2340
mlb|cubs|0E3386|CC3433 mlb|reds|C6011F|000000 mlb|guardians|00385D|E50022 mlb|rockies|33006F|C4CED4
mlb|tigers|0C2340|FA4616 mlb|astros|002D62|EB6E1F mlb|royals|004687|BD9B60 mlb|angels|BA0021|003263
mlb|dodgers|005A9C|EF3E42 mlb|marlins|00A3E0|000000 mlb|brewers|12284B|FFC52F mlb|twins|002B5C|D31145
mlb|mets|002D72|FF5910 mlb|yankees|0C2340|C4CED4 mlb|athletics|003831|EFB21E mlb|phillies|E81828|002D72
mlb|pirates|FDB827|27251F mlb|padres|2F241D|FFC425 mlb|giants|FD5A1E|27251F mlb|mariners|0C2C56|005C5C
mlb|cardinals|C41E3A|0C2340 mlb|rays|092C5C|8FBCE6 mlb|rangers|003278|C0111F mlb|jays|134A8E|1D2D5C
mlb|nationals|AB0003|14225A
nhl|ducks|F47A38|B9975B nhl|bruins|FFB81C|000000 nhl|sabres|002654|FCB514 nhl|flames|D2001C|FAAF19
nhl|hurricanes|CC0000|000000 nhl|blackhawks|CF0A2C|000000 nhl|avalanche|6F263D|236192 nhl|jackets|002654|CE1126
nhl|stars|006847|8F8F8C nhl|wings|CE1126|999999 nhl|oilers|041E42|FF4C00 nhl|panthers|041E42|C8102E
nhl|kings|111111|A2AAAD nhl|wild|154734|A6192E nhl|canadiens|AF1E2D|192168 nhl|predators|FFB81C|041E42
nhl|devils|CE1126|000000 nhl|islanders|00539B|F47D30 nhl|rangers|0038A8|CE1126 nhl|senators|C52032|C2912C
nhl|flyers|F74902|000000 nhl|penguins|000000|FCB514 nhl|sharks|006D75|EA7200 nhl|kraken|001628|99D9D9
nhl|blues|002F87|FCB514 nhl|lightning|002868|888888 nhl|leafs|00205B|FFFFFF nhl|canucks|001F5B|00843D
nhl|knights|B4975A|333F42 nhl|capitals|041E42|C8102E nhl|jets|041E42|004C97 nhl|utah|71AFE5|010101
`;

const COLORS = (() => {
  const map = {};
  for (const token of TABLE.split(/\s+/)) {
    if (!token) continue;
    const [league, nick, a, b] = token.split("|");
    if (!league || !nick) continue;
    map[`${league}:${nick}`] = [`#${a}`, `#${b}`];
  }
  return map;
})();

/** Deterministic fallback so an unmapped team still gets a stable identity. */
function hashColors(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return [`hsl(${h} 62% 42%)`, `hsl(${(h + 40) % 360} 58% 62%)`];
}

export function sportEmoji(sportKey) {
  if (!sportKey) return "🏆";
  if (SPORT_EMOJI[sportKey]) return SPORT_EMOJI[sportKey];
  const k = String(sportKey).toLowerCase();
  if (k.includes("tennis")) return "🎾";
  if (k.includes("soccer")) return "⚽";
  if (k.includes("basketball")) return "🏀";
  if (k.includes("football")) return "🏈";
  if (k.includes("baseball")) return "⚾";
  if (k.includes("hockey")) return "🏒";
  if (k.includes("golf")) return "⛳";
  if (k.includes("mma") || k.includes("boxing")) return "🥊";
  if (k.includes("nascar") || k.includes("motor")) return "🏁";
  return "🏆";
}

export function sportLabel(sportKey) {
  return SPORT_LABEL[sportKey] || (sportKey ? String(sportKey).replace(/_/g, " ") : "Unknown");
}

/**
 * Returns { name, emoji, primary, secondary } for a team or player.
 * Matches on the last significant word, which is how nicknames appear in
 * sportsbook full names ("Los Angeles Lakers" -> "lakers").
 */
export function teamIdentity(rawName, sportKey) {
  const name = (rawName || "Unknown").trim();
  const emoji = sportEmoji(sportKey);
  const league = LEAGUE_OF[sportKey];

  const words = name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  let colors = null;

  if (league) {
    // Try each word from the end - "Toronto Blue Jays" hits "jays".
    for (let i = words.length - 1; i >= 0 && !colors; i--) {
      colors = COLORS[`${league}:${words[i]}`] || null;
    }
  }
  if (!colors) {
    for (let i = words.length - 1; i >= 0 && !colors; i--) {
      const hit = Object.keys(COLORS).find((k) => k.endsWith(`:${words[i]}`));
      if (hit) colors = COLORS[hit];
    }
  }
  if (!colors) colors = hashColors(name);

  return { name, emoji, primary: colors[0], secondary: colors[1] };
}
