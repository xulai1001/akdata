// ---- utils ----
// public name cache
let _names = {};
// public checkSpecs()/getBuff() cache
let _spec = false;
let _buff = null;
let _fps = 30;

let AttributeKeys = [
    'atk',
    'attackSpeed',
    'baseAttackTime',
    'baseForceLevel',
    'blockCnt',
    'cost',
    'def',
    'hpRecoveryPerSec',
    'magicResistance',
    'massLevel',
    'maxDeckStackCnt',
    'maxDeployCount',
    'maxHp',
    'moveSpeed',
    'respawnTime',
    'spRecoveryPerSec',
    'tauntLevel',
];

let PotentialAttributeTypeList = {
    0: "maxHp",
    1: "atk",
    2: "def",
    3: "magicResistance",
    4: "cost",
    5: "blockCnt",
    6: "moveSpeed",
    7: "attackSpeed",
    21: "respawnTime",
};

// 获取ID为tag的角色/技能的额外数据，存放在dps_specialtags.json中
// 前一次调用的结果暂存在_spec里(不考虑重入)
function checkSpecs(tag, spec) {
    let specs = AKDATA.Data.dps_specialtags;
    if ((tag in specs) && (spec in specs[tag]))
      _spec = specs[tag][spec];
    else _spec = false;
    return _spec;
}

function toSigned(x, n=3) { return (x>0 ? "+":"") + x.toFixed(n); }

function isMasked(tag, key) {
    if (checkSpecs(tag, "masked"))
        return (key in _spec);
    else return false;
}

// 对角色attr属性进行插值并取整。攻击间隔不进行取整
function getAttribute(frames, level, minLevel, attr) {
    var ret = (level - minLevel) / (frames[1].level - frames[0].level) * (frames[1].data[attr] - frames[0].data[attr]) + frames[0].data[attr];
    if (attr != "baseAttackTime")
      return Math.round(ret);
    else return ret;
}

// 将blackboard的"[{k:v}]"格式转为正常字典
function getBlackboard(blackboardArray) {
    let blackboard = {};
    blackboardArray.forEach(kv => blackboard[kv.key] = kv.value);
    return blackboard;
}

// 别名替换
function getAliasedBlackboard(buffKey, blackboard, options) {
    var ret = {...blackboard};
    var aliases = checkSpecs(buffKey, "alias");
    if (aliases) { 
        for (var a in aliases) {
            if (a.option_key) {
                if (options[a.option_key]) {
                    ret[a.key] = ret[a.alias_on_true];
                    delete ret[a.alias_on_true];
                    console.log("alias[true] - ", a.key, a.alias_on_true);
                } else if (a.alias_on_false) {
                    // 如果不指定alias_on_false则不进行替换
                    ret[a.key] = ret[a.alias_on_false];
                    delete ret[a.alias_on_false];
                    console.log("alias[false] - ", a.key, a.alias_on_false);
                } else {
                    ret[a.key] = ret[a.alias];
                    delete ret[a.alias];
                }
            }
        }
        console.log("Raw/Aliased", blackboard, ret);
        return ret;
    } else return blackboard;
}

class Log {
    constructor() {
        this.log = {};
        this.muted = false;
        this.keys = ["default"];
    }

    getKey() { return this.keys[this.keys.length-1]; }
    pushKey(s) { this.keys.push(s); }
    popKey() { return this.keys.pop(); }

    write(line, key=null) {
        key ||= this.getKey();
        if (!this.muted) {
            if (!this.log[key]) this.log[key] = [];
            if (this.log[key].indexOf(line) == -1)  // 同样的语句只出现一次
                this.log[key].push(line);
        }
    }
    writeNote(line) {
        this.write(line, "note");
    }

    toString(key=null) {
        if (key)
            return this.log[key].join("\n");
        else {
            var lines=[];
            for (var k in this.log) {
                lines.push(`-- ${k} --`);
                lines.push(this.toString(k));
            }
            return lines.join("\n");
        } 
    }

    toMarkdown(key=null) {
        if (key)
            return this.log[key].join("\n").replace(/_/g, "\\_").replace(/\~/g, "_");
        else {
            var lines=[];
            for (var k in this.log) {
                lines.push(`- ${k}`);
                lines.push(this.toMarkdown(k));
            }
            return lines.join("\n");
        }
    }
}

// ---- 核心模组 ----
// 扩展的char对象，包括原本char的id/技能等级选项等信息，和从DB中提取的技能名字blackboard等信息。
class CharAttribute {
    setChar(char) {
        // 设置人物和技能数据
        this.changeCharId(char.charId);
        this.changeSkillId(char.skillId);
        // 复制原本的char对象内容
        this.phase = char.phase || this.charData.phases.length - 1;
        this.level = char.level || this.charData.phases[this.phase].maxLevel;
        this.favor = char.favor || 200;
        this.potentialRank = char.potentialRank || 5;
        this.options = {...char.options};
        return this;
    }

    // 切换为其他角色，不改变等级等属性
    // 除了setChar以外，处理召唤物时也要用到
    changeCharId(charId) {
        this.charId = charId;
        this.charData = AKDATA.Data.character_table[charId];
        _names[this.charId] ||= this.charData.name;
        return this;
    }

    // 切换为其他技能，不改变其他属性
    changeSkillId(skillId) {
        this.skillId = skillId;
        this.skillData = AKDATA.Data.skill_table[skillId];
        if (!this.skillLevel || this.skillLevel < 0
            || this.skillLevel > this.skillData.levels.length-1)
            this.skillLevel = this.skillData.levels.length-1;
        this.levelData = this.skillData.levels[this.skillLevel];
        this.blackboard = getBlackboard(this.skillData.levels[this.skillLevel].blackboard) || {};
        this.blackboard = getAliasedBlackboard(skillId, this.blackboard, this.options);   // 别名处理
        this.blackboard.id = this.skillId;
        this.skillName = this.levelData.name;
        _names[this.skillId] ||= this.skillName;
    }

    clone() {
        var ret = new CharAttribute();
        ret.setChar(this);
        return ret;
    }

    explain(log) {
        log.pushKey("CharAttribute");
        log.write(`| 角色 | 等级 | 技能 |`);
        log.write(`| :--: | :--: | :--: | `);
        log.write(`| ~${this.charId}~ - **${this.charData.name}**  | 精英 ${this.phase}, 等级 ${this.level},
                                      潜能 ${this.potentialRank+1} | ${this.skillName}, 等级 ${this.skillLevel+1} |`);
        log.popKey();
    }

    getDamageType() {
        var ret = { normal: 0, skill: 0 };
        // 优先读取spec
        var skillDesc = this.levelData.description;
        // skill
        if (checkSpecs(this.skillId, "damage_type"))
            ret.skill = ~~_spec;
        else if (checkSpecs(this.charId, "damage_type"))
            ret.skill = ~~_spec;
        else if (this.options.token && checkSpecs(this.charId, "token_damage_type"))
            ret.skill = ~~_spec;
        else {
            if (["法术伤害", "法术</>伤害", "伤害类型变为"].some(x => skillDesc.includes(x)))
            ret.skill = 1;
            else if (["治疗", "恢复", "每秒回复"].some(x => skillDesc.includes(x)) && 
                    !this.blackboard["hp_recovery_per_sec_by_max_hp_ratio"])
            ret.skill = 2;
        }
        // normal
        if (this.options.token && checkSpecs(this.charId, "token_damage_type"))
            ret.normal = ~~_spec;
        else {
            if (this.charData.profession == "MEDIC")
                ret.normal = 2;
            else if (this.charData.description.includes('法术伤害') && !["char_260_durnar", "char_378_asbest"].includes(charId))
                ret.normal = 1;
        }
        this.damageType = ret;
        return ret;
    } // getDamageType

    canResetAttack() {
        return (checkSpecs(this.skillId, "reset_attack") != false || 
            ["base_attack_time", "attack@max_target", "max_target"].some(
                x => this.blackboard[x] != null
            )
        );
    }
}

function initBuffFrame() {
    return {
      atk_scale: 1,
      def_scale: 1,
      heal_scale:1,
      damage_scale: 1,
      maxTarget: 1,
      times: 1,
      edef:0, // 敌人防御/魔抗
      edef_scale:1,
      edef_pene:0,
      edef_pene_scale:0,
      emr_pene:0, // 无视魔抗
      emr:0,
      emr_scale:1,
      atk:0,
      def:0,
      attackSpeed:0,
      maxHp: 0,
      baseAttackTime:0,
      spRecoveryPerSec:0,
    };
}

function cloneBuffFrame(frame) {
    return {...frame};
}

// 存放一次计算的所有数据和状态
class DpsState {
    constructor() {
        this.log = new Log();
        this.flags = {skill: false, crit: false, enemy: false, defer: false};
        this.buffList = {}; // 所有buff / buffList["buff"] = { blackboard }
        this.applied = {};  // 已生效buff / applied["buff"] = true/false
        this.buffFrame = initBuffFrame();    // 当前计算的buff属性
        this.basicFrame = {};   // 基础面板
        this.finalFrame = {};   // 计算buff后的最终面板
        this.attackTime = {};
        this.rotation = {};
        // other entries will be created on use
    }

    setChar(char) {
        this.char = new CharAttribute();
        this.char.setChar(char);
        this.char.explain(this.log);
        this.skillId = char.skillId;
        this.options = char.options;
    }

    setEnemy(enemy=null) {
        this.enemy = enemy || { def: 0, magicResistance: 0, count: 1};
        this.flags.enemy = true;    // 更新为enemy已经设置的状态
    }

    setRaidBuff(rb=null) {
        this.raidBuff = rb || { atk: 0, atkpct: 0, ats: 0, cdr: 0, 
                                base_atk: 0, damage_scale: 0};
        // 把raidBuff处理成blackboard的格式
        this.raidBlackboard = {
            atk: this.raidBuff.atkpct / 100,
            atk_override: this.raidBuff.atk,
            attack_speed: this.raidBuff.ats,
            sp_recovery_per_sec: this.raidBuff.cdr / 100,
            base_atk: this.raidBuff.base_atk / 100,
            damage_scale: 1 + this.raidBuff.damage_scale / 100
        };
        _names["raidBuff"] = "团辅";
    }

    getBuff(b) { _buff = this.buffList[b]; return this.buffList[b]; }

    getDamageType() { 
        if (!this.char.damageType) this.char.getDamageType();
        return this.char.damageType[this.flags.skill ? "skill" : "normal"];
    }

    // 基础属性计算
    calcBasicFrame() {
        var charData = this.char.charData;
        var phaseData = charData.phases[this.char.phase];
        var basicFrame = {};

        // 计算基础属性插值，包括等级和信赖
        if (this.char.level == phaseData.maxLevel) {
            basicFrame = Object.assign(basicFrame, phaseData.attributesKeyFrames[1].data);
        } else {
            AttributeKeys.forEach(key => {
                // 等级范围: 1-90(不包含0)
                basicFrame[key] = getAttribute(phaseData.attributesKeyFrames, this.char.level, 1, key);
            });
        }
        if (charData.favorKeyFrames) {
            let favorLevel = Math.floor(Math.min(this.char.favor, 100) / 2);
            AttributeKeys.forEach(key => {
                // 信赖范围: 0-200(包含0)
                basicFrame[key] += getAttribute(charData.favorKeyFrames, favorLevel, 0, key);
            });
        }
        // 计算潜能
        if (charData.potentialRanks && charData.potentialRanks.length > 0) {
            for (let i = 0; i < this.char.potentialRank; i++) {
                let potentialData = charData.potentialRanks[i];
                if (potentialData.buff) {
                    let y = potentialData.buff.attributes.attributeModifiers[0];
                    let key = PotentialAttributeTypeList[y.attributeType];
                    basicFrame[key] += y.value;
                }
            }
        }
        // 计算直接乘算的团辅字段（合约tag）
        if (this.raidBlackboard.base_atk != 0) {
            let delta = basicFrame.atk * this.raidBlackboard.base_atk;
            let prefix = (delta > 0 ? "+" : "");
            basicFrame.atk = Math.round(basicFrame.atk + delta);
            this.log.write(`[团辅] 原本攻击力变为 ${basicFrame.atk} (${toSigned(delta, 1)})`);         
        }

        this.basicFrame = basicFrame;
        return basicFrame;
    }
    
    // 列出生效的buff
    makeBuffList() {
        // 天赋与特性
        var talents = [...this.char.charData.talents]; // shallow copy
        if (this.char.charData.trait) talents.unshift(this.char.charData.trait);

        talents.forEach(ta => {
            for (var i=ta.candidates.length-1; i>=0; i--) {
                // 倒序查找可用的天赋等级
                let cd = ta.candidates[i];
                if (!cd.prefabKey) { 
                    cd.prefabKey = "trait"; cd.name = "特性";
                }
                if (this.char.phase >= cd.unlockCondition.phase &&
                    this.char.level >= cd.unlockCondition.level &&
                    this.char.potentialRank >= cd.requiredPotentialRank) {
                        var prefabKey = `tachr_${this.char.charId.slice(5)}_${cd.prefabKey}`;
                        _names[prefabKey] = cd.name;
                        this.buffList[prefabKey] = getAliasedBlackboard(prefabKey, getBlackboard(cd.blackboard), this.options);
                        break;
                    }
            }
        });

        // 技能
        this.buffList["skill"] = this.char.blackboard;

        // 团辅
        if (this.options.buff) this.buffList["raidBuff"] = this.raidBlackboard;
    }

    // 判断指定buff是否生效。返回true/false
    checkBuff(buffKey) {
        if (this.applied[buffKey])
            return false;   // 防止重算  
        else if (buffKey == "skill" && !this.flags.skill)
            return false;   // 非技能时，skill buff不生效
        else if (checkSpecs(buffKey, "enemy") && !this.flags.enemy)
            return false;   // 有enemy标签的buff需要在敌人属性给定后才能计算
        else if (checkSpecs(buffKey, "defer") && !this.flags.defer)
            return false;   // 延后计算的tag，会在rotation计算之后，enemy计算之前进行
        else if (buffKey == "raidBuff" && !this.options.buff)
            return false;   // 未选择计算团辅时 raidBuff不生效
        else if (checkSpecs(buffKey, "cond") && !this.options.cond) {
            // cond不满足时，cond buff不生效
            // 特判: W技能眩晕必定有天赋加成
            if (buffKey == "tachr_113_cqbw_2" && this.flags.skill)
                return true;
            else return false;   
        }
        else if (checkSpecs(buffKey, "stack") && !this.options.stack)
            return false;   // stack ~
        else if (checkSpecs(buffKey, "crit") && !(this.flags.crit && this.options.crit))
            return false;   // 有crit标签，但是当前状态不是计算暴击时 / 未选择暴击选项时 不生效

        return true;
    }

    // 默认的applyBuff动作
    applyBuffDefault(buffKey, bboard) {
        var prefix = 0;
        var buffFrame = this.buffFrame;
        var blackboard = {...bboard};   // shallow copy
    
        // currying
        function writeBuff(text) {
            writeBuffDefault(this, buffKey, text);
        }
    
        // note
        if (checkSpecs(buffKey, "note"))
            this.log.writeNote(_spec);
        // mask
        // 只对applyBuff生效，后续计算不进行mask
        var maskedKeys = checkSpecs(buffKey, "masked");
        if (maskedKeys) {
            if (maskedKeys == true) {
                console.log("masked - ", buffKey);
                return buffFrame;   // 为true直接返回
            } else {
                for (var k in maskedKeys) {
                    console.log("masked -", k);
                    delete blackboard[k];
                }
            }
        }
        // ranged_penalty
        if (checkSpecs(buffKey, "ranged_penalty") && this.options.ranged_penalty) {
            blackboard.atk_scale ||= 1;
            blackboard.atk_scale *= _spec;
            writeBuff(`远程惩罚: atk_scale = ${blackboard.atk_scale.toFixed(2)} (x${_spec.toFixed(1)})`);
        }
        // stack
        if (blackboard.max_stack_cnt) {
            ["atk", "def", "attack_speed", "max_hp"].forEach(key => {
                if (blackboard[key]) blackboard[key] *= blackboard.max_stack_cnt;
            });
        }
        // max_target spec
        if (checkSpecs(buffKey, "max_target")) {
            buffFrame.maxTarget = (_spec == "all") ? 999 : _spec;
            writeBuff(`最大目标数: ${buffFrame.maxTarget}`);
        } else if (this.char.charData.description.includes("阻挡的<@ba.kw>所有敌人") &&
                   buffFrame.maxTarget < this.basicFrame.blockCnt) {
            buffFrame.maxTarget = this.basicFrame.blockCnt;
        } else if (this.char.charData.description.includes("恢复三个"))
            buffFrame.maxTarget = 3;
        // sec spec
        if (checkSpecs(buffKey, "sec")) {
            blackboard.base_attack_time = 1 - (this.basicFrame.baseAttackTime + buffFrame.baseAttackTime);
            buffFrame.attackSpeed = 0;
            blackboard.attack_speed = 0;
            writeBuff("每秒造成一次伤害/治疗");
        }
        // times spec (skill only)
        if (checkSpecs(buffKey, "times"))
            blackboard.times ||= _spec;
        
        // original applyBuff
        for (var key in blackboard) {
            switch (key) {
                case "atk":
                case "def":
                    prefix = blackboard[key] > 0 ? "+" : "";
                    buffFrame[key] += this.basicFrame[key] * blackboard[key];
                    if (blackboard[key] != 0)
                        writeBuff(`${key}: ${prefix}${(blackboard[key]*100).toFixed(1)}% (${prefix}${(this.basicFrame[key] * blackboard[key]).toFixed(1)})`);
                    break;
                case "max_hp":
                    prefix = blackboard[key] > 0 ? "+" : "";
                    if (Math.abs(blackboard[key]) > 2) { // 加算
                        buffFrame.maxHp += blackboard[key];
                        writeBuff(`${key}: ${prefix}${blackboard[key]}`);
                    } else if (blackboard[key] != 0) { // 乘算
                        buffFrame.maxHp += this.basicFrame.maxHp * blackboard[key];
                        writeBuff(`${key}: ${prefix}${(blackboard[key]*100).toFixed(1)}% (${prefix}${(this.basicFrame.maxHp * blackboard[key]).toFixed(1)})`);
                    }
                    break;
                case "base_attack_time":
                    if (blackboard.base_attack_time < 0) { // 攻击间隔缩短 - 加算
                        buffFrame.baseAttackTime += blackboard.base_attack_time;
                        writeBuff(`base_attack_time: ${buffFrame.baseAttackTime.toFixed(3)}s`);
                    } else {  // 攻击间隔延长 - 乘算
                        buffFrame.baseAttackTime += this.basicFrame.baseAttackTime * blackboard.base_attack_time;
                        writeBuff(`base_attack_time: +${(this.basicFrame.baseAttackTime * blackboard.base_attack_time).toFixed(3)}s`);
                    }
                    break;
                case "attack_speed":
                    if (blackboard[key] == 0) break;
                    prefix = blackboard[key] > 0 ? "+" : "";
                    buffFrame.attackSpeed += blackboard.attack_speed;
                    writeBuff(`attack_speed: ${prefix}${blackboard.attack_speed}`);
                    break;
                case "sp_recovery_per_sec":
                    buffFrame.spRecoveryPerSec += blackboard.sp_recovery_per_sec;
                    if (blackboard[key]>0) writeBuff(`sp: +${buffFrame.spRecoveryPerSec}/s`);
                    break;
                case "atk_scale":
                case "def_scale":
                case "heal_scale":
                case "damage_scale":
                    buffFrame[key] *= blackboard[key];
                    if (blackboard[key] != 1) writeBuff(`${key}: ${blackboard[key].toFixed(2)}x`);
                    break;
                case "attack@atk_scale":
                    buffFrame.atk_scale *= blackboard["attack@atk_scale"];
                    writeBuff(`atk_scale: ${buffFrame.atk_scale.toFixed(2)}`);
                    break;
                case "attack@heal_scale":
                    buffFrame.heal_scale *= blackboard["attack@heal_scale"];
                    writeBuff(`heal_scale: ${buffFrame.heal_scale.toFixed(2)}`);
                    break;
                case "max_target":
                case "attack@max_target":
                    buffFrame.maxTarget = Math.max(buffFrame.maxTarget, blackboard[key]);
                    writeBuff(`maxTarget: ${buffFrame.maxTarget}`);
                    break;
                case "times":
                case "attack@times":
                    buffFrame.times = blackboard[key];
                    writeBuff(`攻击次数: ${blackboard[key]}`);
                    break;
                case "magic_resistance":
                    if (blackboard[key] < -1) { // 魔抗减算
                        buffFrame.emr += blackboard[key];
                        writeBuff(`敌人魔抗: ${blackboard[key]}% (加算)`);
                    } else if (blackboard[key] < 0) { // 魔抗乘算
                        buffFrame.emr_scale *= (1+blackboard[key]);
                        writeBuff(`敌人魔抗: ${(blackboard[key]*100).toFixed(1)}% (乘算)`);
                    } // 大于0时为增加自身魔抗，不计算
                    break;
                case "prob":
                    if (!blackboard["prob_override"]) {
                        buffFrame.prob = blackboard[key];
                        writeBuff(`概率(原始): ${Math.round(buffFrame.prob*100)}%`);
                    }
                    break;
                // 计算值，非原始数据
                case "edef":  // 减甲加算值（负数）
                    buffFrame.edef += blackboard[key];
                    writeBuff(`敌人护甲: ${blackboard[key]}`);
                    break;
                case "edef_scale": // 减甲乘算值
                    buffFrame.edef_scale *= (1+blackboard[key]);
                    writeBuff(`敌人护甲: ${blackboard[key] *100}%`);
                    break;
                case "edef_pene": // 无视护甲加算值
                    buffFrame.edef_pene += blackboard[key];
                    writeBuff(`无视护甲（最终加算）: -${blackboard[key]}`);
                    break;
                case "edef_pene_scale":
                    buffFrame.edef_pene_scale = blackboard[key];
                    writeBuff(`无视护甲（最终乘算）: -${blackboard[key]*100}%`);
                    break;
                case "emr_pene":  // 无视魔抗加算值
                    buffFrame.emr_pene += blackboard[key];
                    writeBuff(`无视魔抗（加算）: -${blackboard[key]}`);
                    break;
                case "prob_override": // 计算后的暴击概率，有alias无法处理的情况所以保留
                    buffFrame.prob = blackboard[key];
                    writeBuff(`概率(计算): ${Math.round(buffFrame.prob*100)}%`);
                    break;
                case "atk_override":  // 攻击团辅(raidBuff使用)
                    buffFrame.atk += blackboard[key];
                    prefix = blackboard[key] > 0 ? "+" : "";
                    if (blackboard[key] != 0)
                        writeBuff(`atk(+): ${prefix}${(blackboard[key]*100).toFixed(1)}`);
                    break;
            } // switch
        }
        buffFrame.applied[buffKey] = true;
        return buffFrame;
    }

    // 将{buffKey, bboard}指定的buff属性叠加到当前的buffFrame上
    applyBuff(buffKey, bboard) {
        var prefix = 0;
        var buffFrame = this.buffFrame;
        var skillId = this.skillId;
        var flags = this.flags;
        var blackboard = {...bboard};    // shallow copy
        var done = false; // if !done, will call applyBuffDefault() in the end

        // gatekeeper
        if (!checkBuff(buffKey)) return buffFrame;

        this.log.pushKey("applyBuff");

        if (buffKey == "skill") buffKey = skillId;
        // 特判
        switch (buffKey) {
            case "tachr_185_frncat_1":  // 慕斯
                buffFrame.times = 1 + blackboard.prob;
                writeBuff(`攻击次数 x ${buffFrame.times}`);
                done = true; break;
            case "tachr_109_fmout_1": // 远山
                if (skillId == "skcom_magic_rage[2]") {
                    blackboard.attack_speed = 0;
                    this.log.writeNote("抽攻击卡");          
                } else if (skillId == "skchr_fmout_2") {
                    blackboard.atk = 0;
                    this.log.writeNote("抽攻速卡");
                }
                break;
            case "tachr_373_lionhd_1":  // 莱恩哈特 (与敌人相关)
                blackboard.atk *= Math.min(this.enemy.count, blackboard.max_valid_stack_cnt);
                break;
            case "skchr_bluep_2":
                // 蓝毒2: 只对主目标攻击多次
                buffFrame.maxTarget = 3;
                writeBuff(`最大目标数 = ${buffFrame.maxTarget}, 主目标命中 ${blackboard["attack@times"]} 次`);
                delete blackboard["attack@times"]; // 额外攻击后面计算
                break;
            case "skchr_yuki_2":
                blackboard["attack@atk_scale"] *= 3;
                writeBuff(`满伤害倍率: ${blackboard["attack@atk_scale"]}，但可能少一段伤害`);
                break;
            case "skchr_vodfox_1":
                buffFrame.damage_scale = 1 + (buffFrame.damage_scale - 1) * blackboard.scale_delta_to_one;
                break;
            case "skchr_thorns_2":
                this.log.writeNote("反击按最小间隔计算");
                blackboard.base_attack_time = blackboard.cooldown - (this.basicFrame.baseAttackTime + buffFrame.baseAttackTime);
                buffFrame.attackSpeed = 0;
                blackboard.attack_speed = 0;
            // 暴击类
            case "tachr_290_vigna_1":
                blackboard.prob_override = (flags.skill ? blackboard.prob2 : blackboard.prob1);
                break;
            case "tachr_106_franka_1": // 芙兰卡
                blackboard.edef_pene_scale = 1;
                if (flags.skill && skillId == "skchr_franka_2")
                blackboard.prob_override = 0.5;
                break;
            case "tachr_155_tiger_1":
                blackboard.prob_override = blackboard["tiger_t_1[evade].prob"];
                blackboard.atk = blackboard["charge_on_evade.atk"];
                break;
            case "tachr_340_shwaz_1":
                if (flags.skill) blackboard.prob_override = this.buffList.skill["talent@prob"];
                blackboard.edef_scale = blackboard.def;
                delete blackboard["def"]; 
                break;
            case "tachr_225_haak_1":
                blackboard.prob_override = 0.25;
                break;
            case "skchr_peacok_1":
                blackboard.prob_override = blackboard["peacok_s_1[crit].prob"];
                if (flags.crit) blackboard.atk_scale = blackboard.atk_scale_fake;
                break;
            case "skchr_peacok_2":
                if (flags.crit) {
                    writeBuff(`成功 - atk_scale = ${blackboard["success.atk_scale"]}`);
                    blackboard.atk_scale = blackboard["success.atk_scale"];
                    buffFrame.maxTarget = 999;
                } else {
                    writeBuff("失败时有一次普攻")
                }
                break;
            case "skchr_tomimi_2":
                blackboard.prob_override = blackboard["attack@tomimi_s_2.prob"] / 3;
                delete blackboard.base_attack_time;
                if (flags.crit) {
                    blackboard.atk_scale = blackboard["attack@tomimi_s_2.atk_scale"];
                    this.log.writeNote(`每种状态概率: ${(blackboard.prob_override*100).toFixed(1)}%`);
                }
                break;
            // 算法改变类
            case "tachr_187_ccheal_1":
            case "tachr_147_shining_1": // 防御力增加(加算)
                writeBuff(`def +${blackboard.def}`);
                buffFrame.def += blackboard.def;
                delete blackboard[def];
                break;
            case "skchr_hmau_2":
            case "skchr_spot_1":
            case "tachr_193_frostl_1":
            case "skchr_mantic_2":
            case "skchr_glaze_2":
            case "skchr_zumama_2": // 攻击间隔延长，但是是加算
                buffFrame.baseAttackTime += blackboard.base_attack_time;
                writeBuff(`base_attack_time + ${blackboard.base_attack_time}s`);
                blackboard.base_attack_time = 0;
                break;
            case "skchr_brownb_2":  // 攻击间隔缩短，但是是乘算负数
                writeBuff(`base_attack_time: ${blackboard.base_attack_time}x`);
                blackboard.base_attack_time *= this.basicFrame.baseAttackTime;
                break;
            case "skchr_aglina_2":  // 攻击间隔缩短，但是是乘算正数
            case "skchr_cerber_2":
            case "skchr_finlpp_2": 
                writeBuff(`base_attack_time: ${blackboard.base_attack_time}x`);
                blackboard.base_attack_time = (blackboard.base_attack_time - 1) * this.basicFrame.baseAttackTime;
                break;
            case "skchr_angel_3": // 攻击间隔双倍减算
                writeBuff("攻击间隔双倍减算");
                blackboard.base_attack_time *= 2;
                break;
            // 开关类
            case "tachr_344_beewax_trait":
                if (flags.skill) done = true; break;
            case "tachr_411_tomimi_1":
                if (!flags.skill) done = true; break;
            case "tachr_164_nightm_1":  // 夜魔
                if (skillId == "skchr_nightm_1") done = true; break;
            case "tachr_367_swllow_1":  // 灰喉天赋
                if (!flags.crit) delete blackboard.atk_scale; break;
            case "skchr_folivo_1":
            case "skchr_folivo_2":
            case "skchr_deepcl_1":
                if (!this.options.token) {
                    blackboard.atk = 0; // 不增加本体攻击
                    blackboard.def = 0;
                }
                break;
            case "skchr_sora_2":
                blackboard.atk = 0; // 不增加本体攻击
                blackboard.def = 0;
                break;
            case "skchr_nightm_1":
                writeBuff(`治疗目标数 ${blackboard["attack@max_target"]}`);  
                delete blackboard["attack@max_target"];
                break;
            // 可变类
            case "skchr_huang_3": // 可变攻击力技能，计算每段攻击力表格以和其他buff叠加
                buffFrame.maxTarget = 999;
                buffFrame.atk_table = [...Array(8).keys()].map(x => blackboard.atk / 8 *(x+1));
                writeBuff(`技能攻击力系数: ${buffFrame.atk_table.map(x => x.toFixed(2))}`);
                break;
            case "skchr_phatom_2":
                buffFrame.atk_table = [...Array(blackboard.times).keys()].reverse().map(x => blackboard.atk * (x+1));
                writeBuff(`技能攻击力系数: ${buffFrame.atk_table.map(x => x.toFixed(2))}`);
                delete blackboard.times;
                break;
        }

        if (!done) applyBuffDefault(buffKey, blackboard);
        buffFrame.applied[buffKey] = true;
        this.log.popKey();

        return buffFrame;
    }

    updateBuffFrame() {
        for (var b in this.buffList)
            this.applyBuff(b, this.buffList[b]);
    }

    calcFinalFrame() {
        let final = {...this.basicFrame};
        var buffs = this.buffFrame;
        AttributeKeys.forEach(key => {
            if (buffs[key]) final[key] += buffs[key];
        });
        final.atk *= buffs.atk_scale;
        if (this.getDamageType() == 2)
            final.atk *= buffs.heal_scale;
        this.finalFrame = final;
        return final;
    }

    // 计算当前buff下的攻击间隔
    calcAttackTime() {
        var _spd = Math.min(Math.max(10, buffFrame.attackSpeed), 600);
        if (buffFrame.attackSpeed != _spd) {
            buffFrame.attackSpeed = _spd;
            this.log.write(`攻速超过界限，修正为${_spd}`, "rotation");
        }
        var realTime = buffFrame.baseAttackTime * 100 / buffFrame.attackSpeed;
        // token?
        var f = Math.round(realTime * _fps);
        var corr = checkSpecs(this.char.charId, "frame_corr") || 0;
        if (this.flags.skill) {
            if (!(checkSpecs(this.char.skillId, "frame_corr") === false))
                corr = _spec;
            if (corr) {
                f += corr;
                this.log.writeNote(`技能帧数延迟+${corr} (${f}帧)`);
            }
        } else {
            if (corr) {
                f += corr;
                this.log.writeNote(`普攻帧数延迟+${corr} (${f}帧)`)
            }
        }
        var frameTime = f / _fps;
        this.attackTime = {
            baseAttackTime: frame.baseAttackTime,
            attackSpeed: frame.attackSpeed,
            frame: f,
            realTime,
            frameTime
        };
        return this.attackTime;
    }

    // 循环计算
    calcRotation() {
        var buffFrame = this.buffFrame;
        var attackTime = this.attackTime.frameTime;
        var blackboard = this.char.blackboard;
        var skillId = this.char.skillId;
        var levelData = this.char.levelData;
        var spData = levelData.spData;
        var duration = 0, attackCount = 0, stunDuration = 0; startSp = 0;
        var isOGCD = (checkSpecs(skillId, "reset_attack") == "ogcd");

        this.log.pushKey("rotation");

        if (this.flags.skill) {
            // 快速估算
            attackCount = Math.ceil(levelData.duration / attackTime);
            duration = attackCount * attackTime;
            startSp = spData.spCost - spData.initSp;

            // 落地sp天赋
            if (this.getBuff("tachr_180_amgoat_2")) {
                var init_sp = spData.initSp + (_buff.sp_min + _buff.sp_max) / 2;
                startSp = spData.spCost - init_sp; 
            } else if (this.getBuff("tachr_222_bpipe_2")) {
                startSp = spData.spCost - spData.initSp - _buff.sp;
            }
            // 重置普攻
            if (this.char.canResetAttack()) {            
                if (duration > levelData.duration && !isOGCD)
                    this.log.write(`可能重置普攻`);
                duration = levelData.duration;
                // 抬手时间
                var beg = 12;
                if (checkSpecs(skillId, "attack_begin")) {
                    beg = _spec;
                    this.log.write(`抬手: ${beg} 帧`);
                    this.log.writeNote(`抬手: ${beg} 帧`);
                } else {
                    this.log.write("暂无抬手时间数据，以12帧进行估算");
                }
                attackCount = Math.ceil((duration - beg / 30 ) / attackTime);
            }

            // 永续技能
            if (levelData.description.includes("持续时间无限")) {
                if (skillId == "skchr_thorns_3" && !this.options.warmup) {}
                else if (skillId == "skchr_surtr_3") {
                    var lock_time = this.getBuff("tachr_350_surtr_2")["surtr_t_2[withdraw].interval"];
                    duration = Math.sqrt(600) + lock_time;
                    attackCount = Math.ceil(duration / attackTime);
                    this.log.write(`损失100%血量耗时: ${Math.sqrt(600).toFixed(1)}s，锁血时间: ${lock_time}s`);
                    this.log.writeNote("不治疗最大维持时间");
                } else {
                    attackCount = Math.ceil(1800 / attackTime);
                    duration = attackCount * attackTime;
                    this.log.writeNote("持续时间无限 (以1800s为参考计算)");
                }
            } else if (spData.spType == 8) {
                // 落地点火/被动类技能
                // 规范化
                if (levelData.duration <= 0 && blackboard.duration > 0) {
                    levelData.duration = blackboard.duration;
                    duration = blackboard.duration;
                    attackCount = Math.ceil(levelData.duration / attackTime);
                }
                // 判断具体类型
                if (checkSpecs(skillId, "passive")) {
                    log.write("被动");
                    attackCount = 1;
                    duration = attackTime;
                } else if (levelData.duration > 0) {
                    log.write("落地点火");
                } else if (skillId == "skchr_phatom_2") { // 傀影2: 单独计算
                    attackCount = blackboard.times;
                    duration = attackTime * attackCount;
                } else { // 摔炮
                    attackCount = 1;
                    duration = 0;
                    log.write("落地点火+瞬发");
                }
            } else if (levelData.duration <= 0) {
                // 普通瞬发技能
                if (checkSpecs(skillId, "instant_buff")) {
                    // 华法琳2类型
                    duration = blackboard.duration || checkSpecs(skillId, "duration");
                    attackCount = Math.ceil(duration / attackTime);
                    log.write("瞬发增益效果");
                } else {
                    log.write("瞬发");
                    // 如果不是OGCD技能则需要占用一次普攻
                    if (!isOGCD) duration = attackTime;
                    // 技能动画时间处理
                    if (checkSpecs(skillId, "cast_time")) {
                        // 调整技能时间为技能动画时间
                        if (isOGCD || (spData.spType == 1 && duration < _spec/_fps))
                            duration = _spec / _fps;
                        this.log.write(`技能动画(阻回) ${_spec} 帧`);
                        this.log.writeNote(`技能动画(阻回) ${_spec} 帧`);
                    }
                }
            } // if levelData.duration

            if (skillId == "skchr_huang_3") {
                attackCount -= 2;
                this.log.write(`${_names["skchr_huang_3"]}: 实际攻击${attackCount}段+终结`);
            }
        } else { // 普攻
            // 眩晕处理
            // 利用alias 把不同的晕眩时间字段都统一到stunDuration上
            var stunDuration = blackboard.stunDuration || 0;
            if (skillId == "skchr_peacok_2") {
                stunDuration *= (1 - blackboard.prob);
                log.writeNote("眩晕时间为期望");
            } else if (skillId == "skchr_folivo_2" && !this.options.token)
                stunDuration = 0;
            if (stunDuration > 0) log.write(`眩晕 ${stunDuration}s`);

            // 根据sp恢复速度估算普攻的最短时间
            let attackDuration = spData.spCost / (1 + buffFrame.spRecoveryPerSec) - stunDuration;
            
            // 施法时间<攻击间隔时会额外恢复一些sp，需要从attackDuration里减去
            if (checkSpecs(skillId, "cast_time")) {
                if (attackTime > _spec/_fps && !isOGCD) {
                    attackDuration -= (attackTime - _spec/_fps);
                    log.write(`技能动画(阻回) ${_spec} 帧`);
                }
            }

            // 重置普攻时，duration即为sp恢复时间
            // 但计算普攻攻击次数时要减去一次抬手的时间
            if (this.char.canResetAttack() && !isOGCD && spData.spType != 8) {
                // 抬手时间
                var beg = checkSpecs(skillId, "attack_begin") || 12;
                duration = attackDuration;
                attackCount = Math.ceil((attackDuration - beg/_fps) / attackTime);
            } else {
                // 不重置普攻则根据完整的攻击次数反推duration
                attackCount = Math.ceil(attackDuration / attackTime);
                duration = attackCount * attackTime;
            }

            switch (spData.spType) {
                case 8: // 被动或落地点火
                    // 规范化
                    if (levelData.duration <= 0 && blackboard.duration > 0) {
                        levelData.duration = blackboard.duration;
                    }
                    if (checkSpecs(skillId, "passive")) { // 被动
                        attackCount = 10;
                        duration = attackCount * attackTime;
                        this.log.writeNote("以10次普攻计算");
                    } else if (levelData.duration > 0) {  // 落地点火
                        attackDuration = levelData.duration;
                        attackCount = Math.ceil(attackDuration / attackTime);
                        duration = attackCount * attackTime;
                        this.log.writeNote("取普攻时间=技能持续时间");
                    } else { // 摔炮
                        attackDuration = 10;
                        attackCount = Math.ceil(attackDuration / attackTime);
                        duration = attackCount * attackTime;
                        this.log.writeNote("以10s普攻计算");
                    }
                    break;
                case 4: // 受击回复
                    this.log.writeNote("受击回复");
                    break;
                case 2: // 攻击回复
                    attackCount = spData.spCost;
                    if (this.getBuff("tachr_010_chen_1")) {
                        attackCount = Math.ceil(spData.spCost / (1 + attackTime / _buff.interval));
                        let sp = Math.floor(attackCount * attackTime / _buff.interval);
                        this.log.write(`[特殊] ${_names["tachr_010_chen_1"]}: sp = ${sp}, attack_count = ${attackCount}`);
                    } else if (this.getBuff("tachr_301_cutter_1")) {
                        let p = _buff.prob;
                        if (skillId == "skchr_cutter_1") {
                        attackCount = Math.ceil((spData.spCost - p) / (1+p*2));
                        this.log.write(`[特殊] ${_names["skchr_cutter_1"]}: 额外判定1次天赋`);   
                        this.log.write(`[特殊] ${_names["tachr_301_cutter_1"]}: sp = ${((attackCount*2+1) * p).toFixed(2)}, attack_count = ${attackCount}`);
                        } else {
                        attackCount = Math.ceil(spData.spCost / (1+p*2));
                        this.log.write(`[特殊] ${_names["tachr_301_cutter_1"]}: sp = ${(attackCount*2*p).toFixed(2)}, attack_count = ${attackCount}`);
                        }
                    }
                    if (this.char.canResetAttack())
                        duration = (attackCount-1) * attackTime;
                    else
                        duration = attackCount * attackTime;
                    break;
                case 1: // 自动回复-特判
                    var sp_rate = 1 + buffFrame.spRecoveryPerSec;
                    if (this.getBuff("tachr_002_amiya_1")) { // 情绪吸收
                    attackCount = Math.ceil((spData.spCost - stunDuration) / (_buff["amiya_t_1[atk].sp"] + attackTime*sp_rate));
                    log.write(`[特殊] ${_names["tachr_002_amiya_1"]}: attack sp = ${attackCount * _buff["amiya_t_1[atk].sp"]}`);
                    duration = attackCount * attackTime;
                    } else if (this.getBuff("tachr_134_ifrit_2")) { // [莱茵回路]. 需要解出攻击次数
                    let i = _buff.interval;
                    let isp = i * sp_rate + _buff.sp;
                    let recoverCount = Math.ceil((spData.spCost - i) / isp); // recoverCount >= (spCost - i) / isp
                    let r = (spData.spCost - recoverCount * isp) / sp_rate;
                    attackDuration = recoverCount * i + r;
                    attackCount = Math.ceil(attackDuration / attackTime);
                    //console.log(i, isp, recoverCount, r, attackDuration, attackCount);
                    duration = attackDuration;
                    log.write(`[特殊] ${_names["tachr_134_ifrit_2"]}: sp + ${recoverCount * _buff.sp}`); 
                    } else if (checkSpecs(skillId, "instant_buff")) { // 不稳定血浆: 减去buff持续时间
                    attackDuration -= blackboard.duration || checkSpecs(skillId, "duration");
                    attackCount = Math.ceil(attackDuration / attackTime);
                    duration = attackCount * attackTime;
                    } else if (this.getBuff("tachr_400_weedy_2") && this.options.cannon) { // 水炮充能，持续20s/cd35s
                    let m = Math.floor(spData.spCost / 55);
                    let a = m * 6 + m * 55 * sp_rate; // 前m个水炮充能+自然恢复的sp量
                    let b = 6 + 20 * sp_rate; // 最后一个水炮持续期间最多恢复的sp
                    let c = 6;  // 最后一个水炮充的sp
                    let r = 0; // 计算还需要多少时间充满
                    if (a + b > spData.spCost) { // 技能会在b期间蓄好
                        let y = Math.floor((spData.spCost - a) / (3 * sp_rate + 1.0));
                        let z = (spData.spCost - a - y) / sp_rate - y*3;
                        r = 3*y+z;
                        c = Math.floor(r/3);
                    } else {
                        r = (spData.spCost - a - b) / sp_rate + 20;
                    }
                    attackDuration = m*55+r;
                    attackCount = Math.ceil(attackDuration / attackTime);
                    duration = attackDuration;
                    log.write(`[特殊] ${_names["tachr_400_weedy_2"]}: 使用${m+1}个水炮, 充能sp=${m * 6 + c}`);
                    }
                    break;
            } // switch
        } // isSkill

        this.log.popKey('rotation');
        this.flags.defer = true;   // 标记rotation已经计算完毕，可以计算deferred buff

        return {
            attackCount,
            attackTime,
            duration, 
            stunDuration,
            startSp
        };

    }
}

class DpsCalculator {
    constructor() {        
        this.states = {};
        ["normal", "skill", "crit", "crit_skill"].forEach(k => {
            this.states[x] = new DpsState();
        });
        this.states["skill"].flags["skill"] = true;
        this.states["crit"].flags["crit"] = true;
        this.states["crit_skill"].flags["skill"] = true;
        this.states["crit_skill"].flags["crit"] = true;
    }

    forEachState(func) {
        for (var k in this.states) func(this.states[k]);
    }

    setup(char, enemy=null, raidBuff=null) {
        this.char = new CharAttribute();
        this.char.setChar(char);
        this.enemy = enemy; // 计算过程中再交给具体的state
        this.raidBuff = raidBuff;
        this.forEachState(st => {
            st.setChar(char);
            st.setRaidBuff(raidBuff);
            st.calcBasicFrame();
            st.makeBuffList();
        });
    }

    calcFinalFrame() {
        this.forEachState(st => {
            // 叠加buff
            st.updateBuffFrame();
            // 根据当前buffFrame，计算攻击间隔和循环
            st.calcAttackTime();
            st.rotation = calcRotation(st);
            // 叠加延迟计算(defer=True)的buff
            st.updateBuffFrame();
            // 计算最终面板
            st.calcFinalFrame();
        });
    }

    calcAttackDamage() {
        this.forEachState(st => {
            st.setEnemy(this.enemy);
            // 叠加跟敌人相关的buff(enemy=True)
            st.updateBuffFrame();
        });
    }

    calcExtraDamage() {

    }

    // 3. 根据当前buffList计算提高的属性
    /*  
    calcBuffFrame() {
        this.buffFrame = {
            normal: initBuffFrame(),
            skill: initBuffFrame({skill: true}),
            crit: initBuffFrame({crit: true}),
            crit_skill: initBuffFrame({crit: true, skill: true})
        };

        for (var b in this.buffList) {
            for (var fr in this.buffFrame)
                applyBuff(this, this.buffFrame[fr], b, this.buffList[b]);
        }
    } */

    // 4. 将计算好的buffFrame属性添加到basicFrame上，计算最终属性


    test() {
        if (checkSpecs(this.char.charId, "note"))
            this.log.writeNote(_spec);
        
        console.log(this.buffList);
        // 普攻
        for (var b in this.buffList)
            applyBuff(this, this.buffFrame, b, this.buffList[b]);
        console.log("normal", this.buffFrame);

        var skillBuffFrame = initBuffFrame();
        this.flags.skill = true;
        // 技能
        for (var b in this.buffList)
            applyBuff(this, skillBuffFrame, b, this.buffList[b]);
        console.log("skill", skillBuffFrame);
        console.log("damageType", this.char.getDamageType());
    }
}

function writeBuffDefault(state, buffKey, text) {
    let line = [""];
    if (buffKey == state.skillId) line.push("[技能]");
    else if (buffKey == "raidBuff") line.push("[团辅/拐]");
    else line.push("[天赋]");
    
    if (checkSpecs(buffKey, "cond")) 
      if (state.options.cond) line.push("[触发]"); else line.push("[未触发]");
    if (checkSpecs(buffKey, "stack") && state.options.stack) line.push("[满层数]"); 
    if (checkSpecs(buffKey, "ranged_penalty")) line.push("[距离惩罚]");
    
    line.push(_names[buffKey] + ": ");
    if (text) line.push(text);
    state.log.write(line.join(" "));
}



AKDATA.Dps = {
    Log,
    DpsState,
};