import * as _ from "lodash";
import * as Promise from "bluebird";
import { Term } from "rethinkdbdash";
import { RethinkConnection } from "./connection";
import { OperatorResponse, SchemaFunc } from "./validators/schema";

export interface RelationMap {
  [key: string]: {
    type: string;
    field: string;
    modelName?: string;
    modelFactory: (model: Model) => typeof Model | string;
  }
}

export interface TagMap {
  [key: string]: string[];
}

export class Model {
  _prev;
  _computedFields;
  _relations: RelationMap;
  _schemaRaw;
  _schema: SchemaFunc;
  _conn: RethinkConnection;
  _pk: string;
  _table: string;
  _db: string;
  _tags: TagMap;

  constructor(data: any = {}, isNew = true) {
    this._defineProperties();
    if (isNew) {
      this._prev = this.getRaw();
      this.assign(data);
    } else {
      this.assign(data);
      this._prev = this.getRaw();
    }
  }
  
  public static all<T extends Model>(): Promise<T[]> {
    return this.prototype.query().run()
      .map(res => new this(res, false));
  }
  
  public static get<T extends Model>(id: any | any[], opts?: string | CollectionOpts): Promise<T> {
    let q: any = this.prototype.query();
    const options: CollectionOpts = this._getCollectionOptions(opts);
    
    if (options.index) {
      q = q.getAll(id, {index: options.index});
      if (options.predicate) q = options.predicate(q);
      
      q = q.run().then(data => data[0]);
    } else {
      q = q.get(id).run();
    }
    
    return q.then(data => data ? new this(data, false) : null);
  }
  
  public static getAll<T extends Model>(id: any | any[], opts?: string | CollectionOpts): Promise<T> {
    let q: any = this.prototype.query();
    const options: CollectionOpts = this._getCollectionOptions(opts);
    
    q = q.getAll(id, {index: options.index});
    if (options.predicate) q = options.predicate(q);
    
    return q.run().map(res => new this(res, false));
  }
  
  public static find<T extends Model>(query: any, limit?: number): Promise<T[]> {
    let q = this.prototype.query().filter(query);
    if (limit) {
      q = q.limit(limit);
    }
    return q.run().map(res => new this(res, false));
  }

  public static changes<T extends Model>(opts: ChangesOpts = {}): Promise<ChangesFeed<T>> {
    return this.prototype.query().changes(opts).run();
  }
  
  private static _getCollectionOptions(opts: string | CollectionOpts) {
    const options: CollectionOpts = {};
    if (_.isString(opts)) {
      const index: string = opts;
      options.index = index;
    } else if (_.isPlainObject(opts)) {
      _.assign(options, opts);
    }
    
    
    return options;
  }

  public query(): Term {
    return this._conn.r.db(this._db).table(this._table);
  }

  public save(): Promise<this> {
    const validation = this.validate();
    if (!validation.valid) {
      return Promise.reject(validation);
    }
    
    const changes = this.getChangedKeys();
    if (changes.length === 0) {
      return Promise.resolve(this);
    }

    const changed = {};
    for (let i = 0, len = changes.length; i < len; i++) {
      this._prev[changes[i]] = this[changes[i]];
      changed[changes[i]] = this[changes[i]];
    }
    
    changed[this._pk] = this[this._pk];
    
    return this.query().insert(changed, {conflict: "update"}).run()
      .then(doc => {
        if (doc.generated_keys) this[this._pk] = doc.generated_keys[0];
        return this;
      })
  }

  public delete(): Promise<this> {
    return this.query().get(this[this._pk]).delete().run();
  }

  public join(key: string, mapFunction: (model: Model) => Model | Promise<Model> = model => model): Promise<this> {
    if (!this._relations) return Promise.reject(new Error(`No relation found for '${key}'`));
    
    const relation = this._relations[key];
    return Promise.resolve()
      .then(() => {
        if (!relation) {
          return Promise.reject(new Error(`No relation found for '${key}'`));
        }
        
        let model;
        if (relation.modelFactory) {
          model = relation.modelFactory(this);
          if (_.isString(model)) {
            model = this._conn.getModel(model);
          }
        } else {
          model = this._conn.getModel(relation.modelName);
        }
        
        if (relation.type === "hasMany") {
          return model.getAll(this[this._pk], relation.field)
            .map(mapFunction);
        } else if (relation.type === "belongsTo") {
          return model.get(this[relation.field]).then(mapFunction);
        }
        
        return Promise.reject(new Error(`Unknown relation type '${relation.type}'`));
      })
      .then(res => {
        this[key] = res;
        return this;
      });
  }
  
  /**
   * Returns a new instance of the Model without fields with the tag specified.
   * NOTE: This will freeze computed fields.
   */
  public withoutFields(...excludedTags: string[]): this {
    if (!this._tags) throw new Error("Not tags defined");
    
    const fields = this.getFields(true);
    
    let returnData = {};
    for (let i = 0, len = fields.length; i < len; i++) {
      const key = fields[i];
      const tags = this._tags[key];
      
      // If this key does not have the tag.
      if (!tags || _.intersection(tags, excludedTags).length === 0) {
        returnData[key] = this[key];
      }
    }
    
    return new (<typeof Model> this.constructor)(returnData) as this;
  }
  
  /**
   * Returns a new instance of the Model only with the fields with the tag specified.
   * NOTE: This will freeze computed fields.
   */
  public withFields(...includedTags: string[]): this {
    if (!this._tags) throw new Error("Not tags defined");
    
    const fields = this.getFields(true);
    
    let returnData = {};
    for (let i = 0, len = fields.length; i < len; i++) {
      const key = fields[i];
      const tags = this._tags[key];
      
      // If this key has the tag.
      if (tags && _.intersection(tags, includedTags).length > 0) {
        returnData[key] = this[key];
      }
    }
    
    return new (<typeof Model> this.constructor)(returnData) as this;
  }

  public validate(): OperatorResponse {
    return this._schema(this.getRaw(), this);
  }
  
  public getRaw() {
    const raw = {};
    const keys = Object.keys(this._schemaRaw);
    for (let i = 0, len = keys.length; i < len; i++) {
      raw[keys[i]] = this[keys[i]];
    }
    return raw;
  }

  public getChangedKeys() {
    return _.reduce(<any>this._prev, (result, value, key) => {
      return _.isEqual(value, this[key]) ? result : result.concat(key);
    }, []);
  }
  
  public getFields(includeComputed: boolean = false) {
    const fields = Object.keys(this._schemaRaw);
    
    if (this._relations) {
      fields.push(...Object.keys(this._relations));
    }
    
    if (includeComputed && this._computedFields) {
      fields.push(...Object.keys(this._computedFields));
    }
    
    return fields;
  }
  
  public assign(data: any) {
    const fields = this.getFields(true);
    
    for (let i = 0, keys = Object.keys(data), len = keys.length; i < len; i++) {
      const key = keys[i];
      if (fields.indexOf(key) > -1 && typeof data[key] !== "undefined") {
        this[key] = data[key];
      }
    }
  }
  
  private _defineProperties() {
    if (this._computedFields) {
      let computedKeys = Object.keys(this._computedFields);
      for (let i = 0, len = computedKeys.length; i < len; i++) {
        let key = computedKeys[i];
        this._defineComputedField(key, this._computedFields[key])
      }
    }

    this._defineProperty("_prev", null);
  }
  
  private _defineProperty(key: string, initialValue) {
    let value = initialValue;
    Object.defineProperty(this, key, {
      get: () => value,
      set: (newValue) => value = newValue,
      enumerable: false,
      configurable: false
    })
  }
  
  private _defineComputedField(key: string, func: (model: this) => any) {
    let frozenValue;
    let isFrozen = false;
    Object.defineProperty(this, key, {
      get: () => {
        if (isFrozen) return frozenValue;
        return func(this);
      },
      set: (value) => {
        isFrozen = true;
        frozenValue = value;
      },
      enumerable: true
    });
  }
}

Model.prototype._pk = "id";

export interface CollectionOpts {
  index?: string;
  predicate?: (q: any) => any;
}

export interface ChangesOpts {
  squash?: boolean | number;
  changefeed_queue_size?: number;
  include_initial?: boolean;
  include_states?: boolean;
  include_offsets?: boolean;
  include_types?: boolean;
}

export interface ChangesFeed<T extends Model> {
  each: (callback: (document: DocumentChange<T>) => any) => any;
}

export interface DocumentChange<T extends Model> {
  old_val: T;
  new_val: T;
  state?: string;
}