'use strict';
// find-my-way's optimized matchers use new Function. Workers forbid dynamic
// code generation, so use equivalent interpreted matchers for the edge bundle.
require('avvio/lib/debug').debug = () => {};
const { StaticNode } = require('find-my-way/lib/node');
const HandlerStorage = require('find-my-way/lib/handler-storage');
const Constrainer = require('find-my-way/lib/constrainer');
StaticNode.prototype._compilePrefixMatch = function () {
  const prefix = this.prefix;
  this.matchPrefix = (path,index) => path.slice(index+1,index+prefix.length) === prefix.slice(1);
};
HandlerStorage.prototype._compileCreateParamsObject = function (names) {
  return values => { const params=Object.create(null); for(let i=0;i<names.length;i++) params[names[i]]=values[i]; return params; };
};
HandlerStorage.prototype._compileGetHandlerMatchingConstraints = function (constrainer) {
  this.constrainedHandlerStores={};
  for(const name of this.constraints) {
    const store=constrainer.newStoreForConstraint(name);
    this.constrainedHandlerStores[name]=store;
    this._buildConstraintStore(store,name);
  }
  this._getHandlerMatchingConstraints = function (derived) {
    let candidates=(1<<this.handlers.length)-1;
    for(const name of this.constraints) {
      const mask=this._constrainedIndexBitmask(name),value=derived[name];
      if(value===undefined) candidates &= mask;
      else { const matches=this.constrainedHandlerStores[name].get(value)||0;
        candidates &= constrainer.strategies[name].mustMatchWhenDerived ? matches : (matches|mask); }
      if(candidates===0)return null;
    }
    for(const [name,strategy] of Object.entries(constrainer.strategies))
      if(strategy.mustMatchWhenDerived&&!this.constraints.includes(name)&&derived[name]!==undefined)return null;
    return this.handlers[31-Math.clz32(candidates)];
  };
};
Constrainer.prototype._buildDeriveConstraints = function () {
  if(this.strategiesInUse.size===0)return;
  this.deriveSyncConstraints=(req,ctx)=>Object.fromEntries([...this.strategiesInUse].map(name=>[name,this.strategies[name].deriveConstraint(req,ctx)]));
};
