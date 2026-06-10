import fs from 'fs';

const logPath = 'C:/Users/ADMIN/.gemini/antigravity-ide/brain/dd8243f7-30b2-4886-a7b0-eda4dac0259c/.system_generated/logs/transcript.jsonl';
const fileContent = fs.readFileSync(logPath, 'utf8');
const lines = fileContent.split('\n');

let step939Replacement = null;
let step985Replacement = null;

for (const line of lines) {
  if (!line.trim()) continue;
  const obj = JSON.parse(line);
  if (obj.step_index === 939 && obj.tool_calls) {
    const call = obj.tool_calls.find(c => c.name === 'replace_file_content');
    if (call) step939Replacement = call.args;
  }
  if (obj.step_index === 985 && obj.tool_calls) {
    const call = obj.tool_calls.find(c => c.name === 'replace_file_content');
    if (call) step985Replacement = call.args;
  }
}

if (step939Replacement) {
  fs.writeFileSync('temp_ddj_realtime.js', step939Replacement.ReplacementContent);
  console.log("Saved temp_ddj_realtime.js");
}
if (step985Replacement) {
  fs.writeFileSync('temp_old_realtime.js', step985Replacement.ReplacementContent);
  console.log("Saved temp_old_realtime.js");
}
