var crc = require('crc');
var BufferPut = require('bufferput');
var Promise = require("bluebird");
var constants = require('./constants');
var binary = require('binary');
var bufferEqual = require('buffer-equal');
var _ = require('lodash');
var errors = require('./errors');

module.exports = Master;

function Master(serialPort) {
    var self = this;

    this.queue = [];
    this.buffers = [];
    this.currentTask = null;

    this.serialPort = serialPort;

    return new Promise(function(resolve, reject){
        self.serialPort.on('error', function(err){
            reject(err);
        });

        self.serialPort.on('close', function(err){
            reject(err);
        })

        self.serialPort.on('disconnect', function(err){
            reject(err);
        })

        self.serialPort.on("open", function () {
            self.processQueue();
            resolve(self)
        });

        var onData = _.debounce(function () {
            var buffer = Buffer.concat(self.buffers);
            constants.DEBUG && console.log('resp', buffer);
            self.doTask(buffer)

            self.buffers = [];
        }, constants.END_PACKET_TIMEOUT);

        serialPort.on('data', function (data) {
            if (self.currentTask) {
                self.buffers.push(data);
                onData(data);
            }
        });
    })
}

Master.prototype.doTask = function (buffer){
    var self = this;
    if (self.currentTask) {
        constants.DEBUG && console.log('resp', buffer);

        try {
            if (buffer.length < 5){
                throw new Error('Small buffer length' + buffer.length);
            }
            if ( !self.checkCrc()){
                throw new errors.crc
            }
            if ( !self.validateRequest(buffer, self.currentTask.slave, self.currentTask.func, self.currentTask.len)){
                throw new Error('Not valid packet for slave ' + self.currentTask.slave + ', func ' + self.currentTask.func + ', len ' + elf.currentTask.len);
            }

            self.currentTask.deferred.resolve(buffer);
        } catch (err){
            self.currentTask.errors.push(err)
            self.currentTask.errCount++;
            if (self.currentTask.errCount > constants.TASK_RETRY_COUNT){
                self.currentTask.errors.push(new Error('Too much errors with this task'));
                return self.currentTask.deferred.reject(self.currentTask.errors);
            }
        }
    }
}

Master.prototype.write = function(buffer, deferred, simple) {
    constants.DEBUG && console.log('write', buffer);
    this.serialPort.write(buffer, function (error) {
        if (error)
            return deferred.reject(error);
        if (simple)
            return deferred.resolve();

    });

    return deferred.promise.timeout(constants.RESPONSE_TIMEOUT, 'Response timeout exceed!');
};

Master.prototype.processQueue = function () {
    var self = this;

    function continueQueue() {
        setTimeout(function(){
            self.processQueue();
        }, constants.QUEUE_TIMEOUT) //pause between calls
    }

    if (this.queue.length) {
        this.currentTask = self.queue.shift();
        this.write(this.currentTask.buffer, this.currentTask.deferred, !this.currentTask.slave && !this.currentTask.func && !this.currentTask.len)
            .catch(function(err){
                self.currentTask.deferred.reject(err)
            })
            .finally(function () {
                continueQueue();
            }).done();
    } else {
        continueQueue();
    }
};

Master.prototype.request = function request(buffer, slave, func, len) {
    var self = this;

    var deferred = {};

    deferred.promise = new Promise(function (resolve, reject) {
        deferred.resolve = resolve;
        deferred.reject = reject;
    });


    this.queue.push({
        deferred: deferred,
        buffer: buffer,
        slave: slave,
        func: func,
        len: len,
        errors: [],
        errCount: 0
    })

    return deferred.promise;
}

Master.prototype.addCrc = function (buffer) {
    return (new BufferPut())
        .put(buffer)
        .word16le(crc.crc16modbus(buffer))
        .buffer();
}

Master.prototype.validateRequest = function (buffer, slave, func, len) {
    var vars = binary.parse(buffer)
        .word8be('slave')
        .word8be('func')
        .word8be('len')
        .vars;
    if (slave && vars.slave != slave){
        return false
    } else if (func && func!=vars.func){
        return false;
    } else if (len && len!=vars.len){
        return false;
    }
    return true;
}

Master.prototype.checkCrc = function (buffer){
    var pdu = buffer.slice(0, buffer.length-2);
    return bufferEqual(buffer, this.addCrc(pdu));
};

Master.prototype.readHoldingRegisters = function (slave, start, length) {
    return this.readRegisters(constants.FUNCTION_CODES.READ_HOLDING_REGISTERS, slave, start, length)
}

Master.prototype.readInputRegisters = function (slave, start, length) {
    return this.readRegisters(constants.FUNCTION_CODES.READ_INPUT_REGISTERS, slave, start, length)
}

Master.prototype.readRegisters = function (func, slave, start, length) {
    var packet = this.createFixedPacket(slave, func, start, length);

    return this.request(packet, slave, start, length)
        .then(function (buffer) {
            var data = binary.parse(buffer.slice(2, buffer.length - 2)); //slice header and crc
            var results = [];

            data.word8('byteCount').tap(function (val) {
                this.buffer('value', val.byteCount).tap(function () {
                    for (var i = 0; i < val.byteCount; i += 2) {
                        results.push(val.value.readInt16BE(i));
                    }
                });
            })

            return results;
        });
}

Master.prototype.read19 = function (slave, start) {
    var packet = this.createFixedPacketSmall(slave, constants.FUNCTION_CODES.READ_ONE_REGISTER, start);

    return this.request(packet, slave, start)
        .then(function (buffer) {
            //var data = binary.parse(buffer.slice(2, buffer.length - 2)); //slice header and crc
            //var results = [];
            //
            //var vars = data
            //    .word8be('hi')
            //    .word8be('lo')
            //    .vars;

            return buffer.readUInt16BE(2);
        });
}

Master.prototype.startRead = function (slave, start, length) {
    var packet = this.createFixedPacket(slave, constants.FUNCTION_CODES.START_READ, start, length);

    return this.request(packet)
}

Master.prototype.writeSingleRegister = function (slave, register, value, retryCount) {
    var packet = this.createFixedPacket(slave, constants.FUNCTION_CODES.WRITE_SINGLE_REGISTER, register, value);
    var self = this;
    retryCount = retryCount ? retryCount : constants.DEFAULT_RETRY_COUNT;

    var performRequest = function (retry) {
        return new Promise(function (resolve) {
            var funcName = 'writeSingleRegister: ';
            var funcId  = ' Slave '+slave+'; ' +
                'Register: '+register+'; Value: '+value+';  Retry ' + (retryCount + 1 - retry) + ' of ' + retryCount;

            if (retry <= 0) {
                throw new Error('Retry limit exceed (retry count  '+retryCount+') ' + funcId);
            }

            constants.DEBUG &&
            console.log(funcName + 'perform request.' + funcId);

            self.request(packet)
                .catch(function (err) {
                    constants.DEBUG &&  console.log(funcName + err  + funcId);

                    return performRequest(--retry);
                }).then(function (data) {
                resolve(data);
            });
        });
    };
    return performRequest(retryCount);
}

Master.prototype.writeMultipleRegisters = function(slave, start, array){
    var packet = this.createVariousPacket(slave, constants.FUNCTION_CODES.WRITE_MULTIPLE_REGISTERS, start, array);
    return this.request(packet);
}

Master.prototype.createFixedPacket = function(slave, func, param, param2){
   return this.addCrc((new BufferPut())
        .word8be(slave)
        .word8be(func)
        .word16be(param)
        .word16be(param2)
        .buffer());
}

Master.prototype.createFixedPacketSmall = function(slave, func, param){
    return this.addCrc((new BufferPut())
        .word8be(slave)
        .word8be(func)
        .word16be(param)
        .buffer());
}


Master.prototype.createVariousPacket = function(slave, func, start, array){
    var buf = (new BufferPut())
        .word8be(slave)
        .word8be(func)
        .word16be(start)
        .word16be(array.length)
        .word8be(array.length*2);

    _.forEach(array, function(value){
        buf.word16be(value);
    })

    return this.addCrc(buf.buffer());
}



