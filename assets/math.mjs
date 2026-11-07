// Exact, bounded arithmetic for the local practice edition. No eval or Function.
export class MathInputError extends Error {}
const gcd = (a,b) => { a=a<0n?-a:a;b=b<0n?-b:b;while(b)[a,b]=[b,a%b];return a||1n; };
export function rational(n,d=1n) {
  n=BigInt(n);d=BigInt(d);
  if(!d)throw new MathInputError('不能除以零。');
  if(d<0n){n=-n;d=-d;}
  const g=gcd(n,d);n/=g;d/=g;
  if((n<0n?-n:n)>10n**18n||d>10n**18n)throw new MathInputError('數值過大，請使用本題的一次式。');
  return {n,d};
}
const add=(a,b)=>rational(a.n*b.d+b.n*a.d,a.d*b.d);
const neg=a=>rational(-a.n,a.d);
const sub=(a,b)=>add(a,neg(b));
const mul=(a,b)=>rational(a.n*b.n,a.d*b.d);
const div=(a,b)=>rational(a.n*b.d,a.d*b.n);
const eq=(a,b)=>a.n===b.n&&a.d===b.d;
const zero=()=>rational(0);
const pairEq=(a,b)=>eq(a.a,b.a)&&eq(a.b,b.b);

function clean(value) {
  const s=String(value).trim().replace(/[−－]/g,'-').replace(/×/g,'*').replace(/÷/g,'/').replace(/（/g,'(').replace(/）/g,')').replace(/＝/g,'=').replace(/[ＸXｘ]/g,'x').replace(/＋/g,'+').replace(/\s/g,'');
  if(!s||s.length>240||!/^[0-9x+*/().=\-]+$/.test(s)||s.includes('**')||s.includes('//'))throw new MathInputError('請輸入 240 字以內的數值、一次式或方程式。');
  let depth=0;for(const c of s){if(c==='('&&++depth>20)throw new MathInputError('括號層數過多。');if(c===')')depth--;}
  return s;
}
function decimal(token) {
  if(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token))throw new MathInputError('數字格式不正確。');
  const [whole,part='']=token.split('.');
  if(part.length>12)throw new MathInputError('請使用較短的小數或分數。');
  return rational(BigInt((whole||'0')+part),10n**BigInt(part.length));
}
export function linear(value) {
  const s=clean(value),tokens=s.match(/\d+(?:\.\d*)?|\.\d+|x|[()+*/-]/g)||[];
  if(tokens.join('')!==s||tokens.length>120)throw new MathInputError('請檢查一次式的符號。');
  let pos=0,depth=0;
  const constant=b=>({a:zero(),b});
  function primary(){
    const t=tokens[pos++];
    if(t==='x')return {a:rational(1),b:zero()};
    if(t==='('){if(++depth>20)throw new MathInputError('括號層數過多。');const out=expression();if(tokens[pos++]!==')')throw new MathInputError('請檢查括號是否成對。');depth--;return out;}
    if(t&&/^(?:\d|\.)/.test(t))return constant(decimal(t));
    throw new MathInputError('請檢查數值、括號與運算符號。');
  }
  function unary(){
    if(tokens[pos]==='+'){pos++;return unary();}
    if(tokens[pos]==='-'){pos++;const p=unary();return {a:neg(p.a),b:neg(p.b)};}
    return primary();
  }
  function product(left,right){
    if(left.a.n&&right.a.n)throw new MathInputError('這個式子包含二次項。');
    return {a:add(mul(left.a,right.b),mul(left.b,right.a)),b:mul(left.b,right.b)};
  }
  function term(){
    let left=unary();
    while(pos<tokens.length){
      const t=tokens[pos];
      if(t==='*'||t==='/'){
        pos++;const right=unary();
        if(t==='*')left=product(left,right);
        else {if(right.a.n)throw new MathInputError('分母不能含未知數。');left={a:div(left.a,right.b),b:div(left.b,right.b)};}
      }else if(t==='x'||t==='('||(tokens[pos-1]===')'&&/^(?:\d|\.)/.test(t)))left=product(left,unary());
      else break;
    }
    return left;
  }
  function expression(){
    let left=term();
    while(tokens[pos]==='+'||tokens[pos]==='-'){
      const op=tokens[pos++],right=term();
      left={a:op==='+'?add(left.a,right.a):sub(left.a,right.a),b:op==='+'?add(left.b,right.b):sub(left.b,right.b)};
    }
    return left;
  }
  const result=expression();
  if(pos!==tokens.length)throw new MathInputError('請檢查是否有多餘符號或未配對括號。');
  return result;
}
export function number(value){
  let s=clean(value);
  if(s.includes('=')){if(!s.startsWith('x=')||s.split('=').length!==2)throw new MathInputError('請輸入數值，或 x = 數值。');s=s.slice(2);}
  const p=linear(s);if(p.a.n)throw new MathInputError('請輸入算出的數值。');return p.b;
}
export function sides(value){
  const parts=clean(value).split('=');
  if(parts.length!==2)throw new MathInputError('方程式需要一個等號。');
  return parts.map(linear);
}
export function solution(value){
  const [left,right]=sides(value),a=sub(left.a,right.a),b=sub(right.b,left.b);
  return !a.n?{kind:!b.n?'all':'none'}:{kind:'one',value:div(b,a)};
}
const sameSolution=(a,b)=>a.kind===b.kind&&(a.kind!=='one'||eq(a.value,b.value));
const verdict=(correct,valid=true,message='')=>({correct,valid,message});
export function grade(q,answer){
  if(q.kind==='multiple_choice'){
    if(!Array.isArray(answer)||!answer.length||new Set(answer).size!==answer.length||answer.some(x=>!q.options.some(o=>o.id===x)))return verdict(false,false,'請選擇有效的選項。');
    return verdict(answer.length===q.answer.length&&answer.every(x=>q.answer.includes(x)));
  }
  if(q.kind==='single_choice'||q.kind==='true_false'){
    if(!q.options.some(o=>o.id===answer))return verdict(false,false,'請先選擇一個選項。');
    return verdict(answer===q.answer);
  }
  if(typeof answer!=='string'||!answer.trim())return verdict(false,false,'請先寫下答案或算式。');
  try{
    if(q.answer_type==='number')return verdict(eq(number(answer),number(q.answer)));
    if(q.answer_type==='expression')return verdict(pairEq(linear(answer),linear(q.answer)));
    if(q.answer_type==='model_equation'){
      const [a,b]=sides(answer),[c,d]=sides(q.answer);
      return verdict((pairEq(a,c)&&pairEq(b,d))||(pairEq(a,d)&&pairEq(b,c)));
    }
    return verdict(sameSolution(solution(answer),solution(q.answer)));
  }catch(e){return verdict(false,false,e.message);}
}
export function checkStep(q,work){
  if(q.work_answer===null)return verdict(false,false,'這題請先選擇選項，再用文字說明理由。');
  try{
    if(q.answer_type==='number'&&q.equation&&clean(work).includes('='))return verdict(sameSolution(solution(work),solution(q.equation)));
    return grade({...q,kind:'short_answer',answer:q.work_answer??q.answer},work);
  }catch(e){return verdict(false,false,e.message);}
}
