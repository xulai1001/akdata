import * as AKDATA from './akdata.esm.js';

console.log("- 请在akdata.js中指定游戏数据路径");
console.log("- 当前AKDATA.GameDataRoot = ", AKDATA.GameDataRoot);

var charId = "char_426_billro";
var skillId = "skchr_billro_3";
var options = { "charge": true };
var char: AKDATA.AKCharacter = {
    charId, skillId, options, skillLevel: 9
};

//var dps = new AKDATA.Dps.DpsCalculator();
//dps.calculateDps({ charId, skillId });
var result = AKDATA.Attributes.calculateDps(char, null, null);
//console.log("----- DPSv2 result -----");
//console.log(dps.summary);
console.log("----- old-DPS (attributes) result -----");
console.log(result);
