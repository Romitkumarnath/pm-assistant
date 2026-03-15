const fs = require('fs');
const path = 'youtrack.js';
let s = fs.readFileSync(path, 'utf8');
// Line 2047: change [}\\]]) (two backslashes -> class matches } or \) 
// to [}\]] (one backslash -> class matches } or ])
const oldPattern = 'jsonStr.replace(/,(\s*[}\\\\\\]])/g, \'$1\')';
const newPattern = 'jsonStr.replace(/,(\s*[}\\\\\\]])/g, \'$1\')';
// In the file we have literally: [ } \ \ ] so we search for the two-backslash version
const twoBackslashes = /replace\(\/,\(\\s\*\[\}\\\\]\]\)\/g,\s*'\$1'\)/;
const oneBackslash = "replace(/,(\s*[}\\]])/g, '$1')";
const idx = s.indexOf("jsonStr = jsonStr.replace(/,(\s*[}\\]])/g, '$1');");
if (idx === -1) {
  console.log('Pattern not found. Searching for similar...');
  const r = /jsonStr = jsonStr\.replace\(\/,\(\\s\*\[[^\]]+\]\)\)\/g, '\$1'\);/;
  const m = s.match(r);
  console.log(m ? 'Found: ' + JSON.stringify(m[0]) : 'No match');
} else {
  // Check how many backslashes are in the character class
  const snippet = s.substring(idx, idx + 70);
  console.log('Snippet:', JSON.stringify(snippet));
  const charClassMatch = snippet.match(/\[([^\]]+)\]/);
  if (charClassMatch) {
    const cc = charClassMatch[1];
    const backslashCount = (cc.match(/\\/g) || []).length;
    console.log('Character class:', JSON.stringify(cc), 'backslashes:', backslashCount);
    if (backslashCount === 2) {
      const newSnippet = "jsonStr = jsonStr.replace(/,(\s*[}\\]])/g, '$1');";
      const newS = s.substring(0, idx) + newSnippet + s.substring(idx + snippet.indexOf(');') + 2);
      fs.writeFileSync(path, newS);
      console.log('Fixed: replaced with one backslash');
    }
  }
}
