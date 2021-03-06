/**
 * Created by slanska on 2016-11-25.
 */

///<reference path="../typings/tsd.d.ts"/>

// import Proto from 'uberproto';
var filter = require('feathers-query-filters').filter;
import errorHandler from './error-handler';
var errors = require('feathers-errors').errors;
import _  = require ('lodash');
import knex = require('knex');
import ActorDB = require('actordb');

const METHODS = {
    $or: 'orWhere',
    $ne: 'whereNot',
    $in: 'whereIn',
    $nin: 'whereNotIn'
};

const OPERATORS = {
    $lt: '<',
    $lte: '<=',
    $gt: '>',
    $gte: '>=',
    $like: 'like',
    $match: 'match', // TODO
};

interface ActorDBServiceOptions
{
    client: ActorDB.ActorDBPool;
    tableName: string; // Table name
    paginate?: {limit?: number, offset?: number};
    id?: string;
    events?: any; // TODO ???
}

// Create the service.
class Service
{
    knex: knex;
    id: string;
    paginate: any;
    table: string;
    events: any;

    constructor(private options: ActorDBServiceOptions)
    {
        if (!options)
        {
            throw new Error('ActorDB options have to be provided');
        }

        if (!options.client)
        {
            throw new Error('You must provide a client');
        }

        if (typeof options.tableName !== 'string')
        {
            throw new Error('No table name specified.');
        }

        this.id = options.id || 'id';
        this.paginate = options.paginate || {};
        // this.events = options.events || [];
    }

    // NOTE (EK): We need this method so that we return a new query
    // instance each time, otherwise it will reuse the same query.
    db()
    {
        return this.knex(this.table);
    }

    // TODO ???
    extend(obj)
    {
        // return Proto.extend(obj, this);
    }

    knexify(query, params, parentKey?)
    {
        Object.keys(params || {}).forEach(key =>
        {
            const value = params[key];

            if (_.isPlainObject(value))
            {
                return this.knexify(query, value, key);
            }

            // const self = this;
            const column = parentKey || key;
            const method = METHODS[key];
            const operator = OPERATORS[key] || '=';

            if (method)
            {
                if (key === '$or')
                {
                    const self = this;

                    return value.forEach(condition =>
                    {
                        query[method](function ()
                        {
                            self.knexify(this, condition);
                        });
                    });
                }
                // eslint-disable-next-line no-useless-call
                return query[method].call(query, column, value);
            }

            return query.where(column, operator, value);
        });
    }

    private _find(params, count?, getFilter = filter)
    {
        const {filters, query} = getFilter(params.query || {});
        let q = this.db().select(['*']);

        // $select uses a specific find syntax, so it has to come first.
        if (filters.$select)
        {
            q = this.db().select(...filters.$select.concat(this.id));
        }

        // build up the knex query out of the query params
        this.knexify(q, query);

        // Handle $sort
        if (filters.$sort)
        {
            Object.keys(filters.$sort).forEach(key =>
                (q = q.orderBy(key, parseInt(filters.$sort[key], 10) === 1 ? 'asc' : 'desc')));
        }

        // Handle $limit
        if (filters.$limit)
        {
            q.limit(filters.$limit);
        }

        // Handle $skip
        if (filters.$skip)
        {
            q.offset(filters.$skip);
        }

        let executeQuery = (total?) =>
        {
            return q.then(data =>
            {
                return {
                    total,
                    limit: filters.$limit,
                    skip: filters.$skip || 0,
                    data
                };
            });
        };

        if (filters.$limit === 0)
        {
            executeQuery = total =>
            {
                return Promise.resolve({
                    total,
                    limit: filters.$limit,
                    skip: filters.$skip || 0,
                    data: []
                });
            };
        }

        if (count)
        {
            let countQuery = this.db().count(`${this.id} as total`);

            this.knexify(countQuery, query);

            return countQuery.then(count => count[0].total).then(executeQuery);
        }

        return executeQuery();
    }

    find(params)
    {
        const paginate = (params && typeof params.paginate !== 'undefined') ? params.paginate : this.paginate;
        const result = this._find(params, !!paginate.default,
            query => filter(query, paginate)
        );

        if (!paginate.default)
        {
            return result.then(page => page.data);
        }

        return result;
    }

    private _get(...args);
    private _get(id, params)
    {
        const query = _.assign({}, params.query);

        query[this.id] = id;

        return this._find(_.assign({}, params, {query}))
            .then(page =>
            {
                if (page.data.length !== 1)
                {
                    throw new errors.NotFound(`No record found for id '${id}'`);
                }

                return page.data[0];
            }).catch(errorHandler);
    }

    get(...args)
    {
        return this._get(...args);
    }

    private _create(data, params)
    {
        return this.db().insert(data, this.id)
            .then(rows =>
            {
                const id = typeof data[this.id] !== 'undefined' ? data[this.id] : rows[0];
                return this._get(id, params);
            })
            .catch(errorHandler);
    }

    create(data, params)
    {
        if (Array.isArray(data))
        {
            return Promise.all(data.map(current => this._create(current, params)));
        }

        return this._create(data, params);
    }

    patch(id, raw, params)
    {
        const query = filter(params.query || {}).query;
        const data = _.assign({}, raw);
        const mapIds = page => page.data.map(current => current[this.id]);

        // By default we will just query for the one id. For multi patch
        // we create a list of the ids of all items that will be changed
        // to re-query them after the update
        const ids = id === null ? this._find(params)
            .then(mapIds) : Promise.resolve([id]);

        if (id !== null)
        {
            query[this.id] = id;
        }

        let q = this.db();

        this.knexify(q, query);

        delete data[this.id];

        return ids
            .then(idList =>
            {
                // Create a new query that re-queries all ids that
                // were originally changed

                const findParams = _.assign({}, params, {
                    query: {
                        [this.id]: {$in: idList},
                        $select: params.query && params.query.$select
                    }
                });

                return q.update(data)
                    .then(() =>
                    {
                        return this._find(findParams).then(page =>
                        {
                            const items = page.data;

                            if (id !== null)
                            {
                                if (items.length === 1)
                                {
                                    return items[0];
                                }
                                else
                                {
                                    throw new errors.NotFound(`No record found for id '${id}'`);
                                }
                            }

                            return items;
                        });
                    });
            }).catch(errorHandler);
    }

    update(id, data, params)
    {
        if (Array.isArray(data))
        {
            return Promise.reject('Not replacing multiple records. Did you mean `patch`?');
        }

        // NOTE (EK): First fetch the old record so
        // that we can fill any existing keys that the
        // client isn't updating with null;
        return this._get(id, params)
            .then(oldData =>
            {
                let newObject = {};

                for (var key of Object.keys(oldData))
                {
                    if (data[key] === undefined)
                    {
                        newObject[key] = null;
                    }
                    else
                    {
                        newObject[key] = data[key];
                    }
                }

                // NOTE (EK): Delete id field so we don't update it
                delete newObject[this.id];

                return this.db()
                    .where(this.id, id)
                    .update(newObject)
                    .then(() =>
                    {
                        // NOTE (EK): Restore the id field so we can return it to the client
                        newObject[this.id] = id;
                        return newObject;
                    });
            })
            .catch(errorHandler);
    }

    remove(id, params)
    {
        params.query = params.query || {};

        // NOTE (EK): First fetch the record so that we can return
        // it when we delete it.
        if (id !== null)
        {
            params.query[this.id] = id;
        }

        return this._find(params)
            .then(page =>
            {
                const items = page.data;
                const query = this.db();

                this.knexify(query, params.query);

                return query.del()
                    .then(() =>
                    {
                        if (id !== null)
                        {
                            if (items.length === 1)
                            {
                                return items[0];
                            }
                            else
                            {
                                throw new errors.NotFound(`No record found for id '${id}'`);
                            }
                        }

                        return items;
                    });
            })
            .catch(errorHandler);
    }
}

export default class init
{
    constructor(options)
    {
        return new init.Service(options);
    }

    static Service: typeof Service;
}

init.Service = Service;
