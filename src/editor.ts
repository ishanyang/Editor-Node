
import * as crc32 from 'buffer-crc32';
import Field from './field';
import knex from 'knex';
import NestedData from './nestedData';

enum Action {
    Read,
    Create,
    Edit,
    Delete,
    Upload
};


export interface DtResponse {
    data?: object[];
    sqlDebug?: object[];
    cancelled?: string[];
    error?: string;
    fieldErrors?: {
        name: string,
        status: string
    }[];
    options?: object;
    files?: object;
}

export interface DtRequest {
    action?: string;
    data?: object[];
}



export default class Editor extends NestedData {
    public static Action = Action;

    public static version: string = '1.7.0';

    public static action ( http ): Action {
        if ( ! http || ! http.action ) {
            return Action.Read;
        }

        switch ( http.action ) {
            case 'create':
                return Action.Create;
            
            case 'edit':
                return Action.Edit;
            
            case 'remove':
                return Action.Delete;
            
            case 'upload':
                return Action.Upload;
            
            default:
                throw new Error( 'Unknown Editor action: '+http.action );
        }
    }



    private _db: knex;
    private _fields: Field[] = [];
    private _formData;
    private _processData;
    private _idPrefix: string = 'row_';
    private _join = [];
    private _pkey: string[] = ['id'];
    private _table: string[] = [];
    private _transaction: boolean = false;
    private _where = [];
    private _leftJoin = [];
    private _out: DtResponse = {};
    private _events = [];
    private _debug: boolean = false;
    private _validator;
    private _tryCatch: boolean = false;
    private _knexTransaction: knex;


    constructor( db: knex=null, table:string|string[]=null, pkey: string|string[]=null ) {
        super();
        
        this.db( db );
        this.table( table );
        this.pkey( pkey );
    }

    public data (): DtResponse {
        return this._out;
    }

    public db (): knex;
    public db (db: knex): Editor;
    public db (db?: knex): any {
        if ( db === undefined ) {
            return this._knexTransaction ?
                this._knexTransaction :
                this._db;
        }

        this._db = db;
        return this;
    }

    public debug (): boolean;
    public debug (debug: boolean): Editor;
    public debug (debug?: boolean): any {
        if ( debug === undefined ) {
            return this._debug;
        }

        this._debug = debug;
        return this;
    }


    public field ( nameOrField: Field|string ) {
        if ( typeof nameOrField === 'string' ) {
            for ( let i=0, ien=this._fields.length ; i<ien ; i++ ) {
                if ( this._fields[i].name() === nameOrField ) {
                    return this._fields[i];
                }
            }

            throw new Error( 'Unknown field: '+nameOrField );
        }

        this._fields.push( nameOrField );
        return this;
    }


    public fields (): Field[];
    public fields (...fields: Field[]): Editor;
    public fields (...fields: Field[]): any {
        if ( fields === undefined || fields.length === 0 ) {
            return this._fields;
        }

        this._fields.push.apply( this._fields, fields );
        
        return this;
    }

    public idPrefix (): string;
    public idPrefix (idPrefix: string): Editor;
    public idPrefix (idPrefix?: string): any {
        if ( idPrefix === undefined ) {
            return this._idPrefix;
        }

        this._idPrefix = idPrefix;
        return this;
    }

    public inData () { // TODO typing
        return this._processData;
    }

    // TODO join

    // TODO leftJoin

    public on ( name: string, callback: Function ): Editor {
        if ( ! this._events[ name ] ) {
            this._events[ name ] = [];
        }

        this._events[ name ].push( callback );

        return this;
    }

    public table (): string[];
    public table (table: string|string[]): Editor;
    public table (table?: string|string[]): any {
        if ( table === undefined || table.length === 0 ) {
            return this._table;
        }

        if ( typeof table === 'string' ) {
            this._table.push( table );
        }
        else {
            this._table.push.apply( this._table, table );
        }
        
        return this;
    }

    public transaction (): boolean;
    public transaction (transaction: boolean): Editor;
    public transaction (transaction?: boolean): any {
        if ( transaction === undefined ) {
            return this._transaction;
        }

        this._transaction = transaction;
        return this;
    }

    public pkey (): string[];
    public pkey (pkey: string|string[]): Editor;
    public pkey (pkey?: string|string[]): any {
        if ( pkey === undefined ) {
            return this._pkey;
        }

        if ( typeof pkey === 'string' ) {
            this._pkey.push( pkey );
        }
        else {
            this._pkey.push.apply( this._pkey, pkey );
        }
        
        return this;
    }

    public pkeyToValue( row: object, flat: boolean=false ): string {
        let pkey = this.pkey();
        let id = [];
        let val;

        for ( let i=0, ien=pkey.length ; i<ien ; i++ ) {
            let column = pkey[i];

            if ( flat ) {
                val = row[ column ] ?
                 row[ column ] :
                 null; 
            }
            else {
                val = this._readProp( column, row );
            }

            if ( val === null ) {
                throw new Error( 'Primary key element is not available in the data set' );
            }

            id.push( val );
        }

        return id.join( this._pkeySeparator() );
    }

    public pkeyToArray ( value: string, flat: boolean=false, pkey: string[]=null): string[] {
        let arr: string[] = [];
        
        value = value.replace( this.idPrefix(), '' );
        let idParts = value.split( this._pkeySeparator() );

        if ( pkey === null ) {
            pkey = this.pkey();
        }

        if ( pkey.length !== idParts.length ) {
            throw new Error( 'Primary key data doesn\'t match submitted data' );
        }

        for ( let i=0, ien=idParts.length ; i<ien ; i++ ) {
            if ( flat ) {
                arr[ pkey[i] ] = idParts[i];
            }
            else {
                this._writeProp( arr, pkey[i], idParts[i] );
            }
        }
    
        return arr;
    }


    public async process ( data: object ): Promise<Editor> {
        if ( this._debug ) {
            // TODO
        }
        let that = this;
        let run = async function () {
            if ( that._tryCatch ) {
                try {
                    await that._process( data );
                }
                catch ( e ) {
                    that._out.error = e.message;

                    if ( that._transaction ) {
                        // TODO Does knex do the rollback automatically for us?
                    }
                }
            }
            else {
                await that._process( data );
            }

        }

        if ( this._transaction ) {
            await this._db.transaction( async function(trx) {
                that._knexTransaction = trx;
                await run();
                that._knexTransaction = null;
            } )
        }
        else {
            await run();
        }

        if ( this._debug ) {
            // TODO
        }

        return this;
    }

    public tryCatch (): boolean;
    public tryCatch (tryCatch: boolean): Editor;
    public tryCatch (tryCatch?: boolean): any {
        if ( tryCatch === undefined ) {
            return this._tryCatch;
        }

        this._tryCatch = tryCatch;
        return this;
    }

    // TODO validate

    // TODO validator

    // TODO where




    private async _process ( data: DtRequest ): Promise<void> {
        this._out = {
            data: []
        };

        if ( ! data.action ) {
            let outData = await this._get( null, data );
            this._out.data = outData.data; // TODO a merge
        }
        else if ( data.action === 'upload' ) {

        }
        else if ( data.action === 'remove' ) {
            await this._remove( data );
        }
        else {
            // create or edit
            let keys = Object.keys( data.data );

            for ( let i=0, ien=keys.length ; i<ien ; i++ ) {
                let cancel = null;
                let idSrc = keys[i];

                // TODO preCreate / preEdit
            
                // One of the event handlers returned false - don't continue
				if ( cancel === false ) {
                    // Remove the data from the data set so it won't be processed
                    delete data.data[ idSrc ];

                    // Tell the client-side we aren't updating this row
                    this._out.cancelled.push( idSrc );
                }
            }

            // Field validation
            // TODO

            keys = Object.keys( data.data );

            for ( let i=0, ien=keys.length ; i<ien ; i++ ) {
                let d = data.action === 'create' ?
                    await this._insert( data.data[keys[i]] ) :
                    await this._update( keys[i], data.data[keys[i]] );

                if ( d !== null ) {
                    this._out.data.push( d );
                }
            }

            // TODO fileClean
        }
    }

    private async _get ( id: string, http: object=null ): Promise<DtResponse> {
        let fields = this.fields();
        let pkeys = this.pkey();
        let query = this
            .db()( this.table() )
            .select( pkeys );

        for ( let i=0, ien=fields.length ; i<ien ; i++ ) {
            if ( pkeys.includes( fields[i].dbField() ) ) {
                continue;
            }

            if( fields[i].apply('get') && fields[i].getValue() === undefined ) {
                query.select( fields[i].dbField() );
            }
        }

        // TODO where
        // TODO leftJoin
        // TODO SSP

        if ( id !== null ) {
            query.where( this.pkeyToArray( id, true ) );
        }

        let result = await query;
        if ( ! result ) {
            throw new Error( 'Error executing SQL for data get. Enable SQL debug using `->debug(true)`' );
        }

        let out = [];
        for ( let i=0, ien=result.length ; i<ien ; i++ ) {
            let inner = {
                'DT_RowId': this.idPrefix() + this.pkeyToValue( result[i], true )
            };

            for ( let j=0, jen=fields.length ; j<jen ; j++ ) {
                if ( fields[j].apply('get') ) {
                    fields[j].write( inner, result[i] );
                }
            }

            out.push( inner );
        }


        // TODO field options

        // TODO Row based joins

        // TODO postGet

        return {
            data: out
        }
    }

    private async _insert( values: object ): Promise<object> {
		// Only allow a composite insert if the values for the key are
		// submitted. This is required because there is no reliable way in MySQL
		// to return the newly inserted row, so we can't know any newly
		// generated values.
		this._pkeyValidateInsert( values );

		// Insert the new row
		let id = await this._insertOrUpdate( null, values );

        // TODO Pkey submitted

        // TODO Join

        // TODO writeCreate

        let row = await this._get( id );
        row = row.data.length > 0 ?
            row.data[0] :
            null;
        
        // TODO postCreate

        return row;
    }

    private async _update( id:string, values: object ): Promise<object> {
        id = id.replace( this.idPrefix(), '' );

        // Update or insert the rows for the parent table and the left joined
        // tables
        await this._insertOrUpdate( id, values );

        // TODO join

        // TODO pkey merge
        let getId = id;

        // TODO writeEdit

        let row = await this._get( getId );
        row = row.data.length > 0 ?
            row.data[0] :
            null;
        
        // TODO postEdit

        return row;
    }

    private async _remove( http:DtRequest ): Promise<void> {
        let ids: string[] = [];
        let keys = Object.keys( http.data );

        for ( let i=0, ien=keys.length ; i<ien ; i++ ) {
            // Strip the ID prefix that the client-side sends back
            let id = keys[i].replace( this.idPrefix(), '' );

            // TODO preRemove event
            let res = true;

            // Allow the event to be cancelled and inform the client-side
            if ( res === false ) {
                this._out.cancelled.push( id );
            }
            else {
                ids.push( id );
            }
        }

        if ( ids.length === 0 ) {
            return;
        }

        // Row based joins - remove first as the host row will be removed which
        // is a dependency
        // TODO joins

        // Remove from the left join tables
        // TODO left join

        // Remove from the primary tables
        let tables = this.table();

        for ( let i=0, ien=tables.length ; i<ien ; i++ ) {
            await this._removeTable( tables[i], ids );
        }

        // TODO postRemove event
    }

    private async _removeTable( table: string, ids: string[], pkey: string[]=null ): Promise<void> {
        if ( pkey === null ) {
            pkey = this.pkey();
        }

        // Check that there is actually a field which has a set option for this table
        let count = 0;
        let fields = this.fields();

        for ( let i=0, ien=fields.length ; i<ien ; i++ ) {
            let dbField = fields[i].dbField();

            if ( dbField.indexOf('.') === -1 ||
                (this._part( dbField, 'table') === table && !fields[i].set())
            ) {
                count++;
            }
        }

        if ( count > 0 ) {
            let q = this._db( table );

            for ( let i=0, ien=ids.length ; i<ien ; i++ ) {
                let cond = this.pkeyToArray( ids[i], true, pkey );

                q.orWhere( function() {
                    this.where( cond );
                } );
            }

            await q.del();
        }
    }


    private async _insertOrUpdate ( id: string, values: object ): Promise<string> {
        // Loop over the tables, doing the insert or update as needed
        let tables = this.table();

        for ( let i=0, ien=tables.length ; i<ien ; i++ ) {
            let res = await this._insertOrUpdateTable(
                tables[i],
                values,
                id !== null ?
                    this.pkeyToArray( id, true ) :
                    null
            );

            // If you don't have an id yet, then the first insert will return
            // the id we want
            if ( id === null ) {
                id = res;
            }
        }

        // TODO left join tables

        return id;
    }

    private async _insertOrUpdateTable( table: string, values: object, where: object=null ) {
        let set = {}, res;
        let action: 'create'|'edit' = (where === null) ? 'create' : 'edit';
        let tableAlias = this._alias( table, 'alias' );
        let fields = this.fields();

        for ( let i=0, ien=fields.length ; i<ien ; i++ ) {
            let field = fields[i];
            let tablePart = this._part( field.dbField() );

            if ( this._part( field.dbField(), 'db' ) ) {
                tablePart = this._part( field.dbField(), 'db' )+'.'+tablePart;
            }

            // Does this field apply to the table (only check when a join is
            // being used)
            if ( this._leftJoin.length && tablePart !== tableAlias ) {
                continue;
            }

            // Check if this field should be set, based on options and
            // submitted data
            if ( ! field.apply( action, values ) ) {
                continue;
            }

            // Some db's (specifically postgres) don't like having the table
            // name prefixing the column name.
            let fieldPart = this._part( field.dbField(), 'column' );
            set[ fieldPart ] = field.val( 'set', values );
        }

        if ( Object.keys(set).length === 0 ) {
            return null;
        }

        if ( action === 'create' ) {
            res = await this
                ._db( table )
                .insert( set )
                .returning( this._pkey );
            
            return res[0].toString(); // TODO test with compound key
        }
        else {
            await this
                ._db( table )
                .update( set )
                .where( where );
        }
    }


    private _part( name:string, type: 'table'|'db'|'column'='table'): string {
        let db, table, column;

        if ( name.indexOf('.') !== -1 ) {
            let a = name.split('.');

            if ( a.length === 3 ) {
                db = a[0];
                table = a[1];
                column = a[2];
            }
            else if ( a.length === 2 ) {
                table = a[0];
                column = a[1];
            }
        }
        else {
            column = name;
        }

        if ( type === 'db' ) {
            return db;
        }
        else if ( type === 'table' ) {
            return table;
        }
        return column;
    }

    private _alias( name: string, type: 'alias'|'orig'='alias'): string {
        if ( name.indexOf( ' as ' ) !== -1 ) {
            let a = name.split(/ as /i);
            return type === 'alias' ?
                a[1] :
                a[0];
        }

        return name;
    }



    private _findField ( name: string, type: 'db'|'name' ): Field {
        let fields = this._fields;

        for ( let i=0, ien=fields.length ; i<ien ; i++ ) {
            let field = fields[i];

            if ( type === 'name' && field.name() === name ) {
                return field;
            }
            else if ( type === 'db' && field.dbField() === name ) {
                return field;
            }
        }

        return null;
    }


    private _pkeyValidateInsert( row: object ): boolean {
        let pkey = this.pkey();

        if ( pkey.length === 1 ) {
            return true;
        }

        for ( let i=0, ien=pkey.length ; i<ien ; i++ ) {
            let column = pkey[i];
            let field = this._findField( column, 'db' );

            if ( ! field || ! field.apply('create', row) ) {
                throw new Error( 'When inserting into a compound key table, '+
                    'all fields that are part of the compound key must be '+
                    'submitted with a specific value.'
                );
            }
        }

        return true;
    }

    private _pkeySeparator (): string {
        let str = this.pkey().join(',');

        return crc32( str );
    }
}