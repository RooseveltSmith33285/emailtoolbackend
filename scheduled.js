const mongoose=require('mongoose')

const scheduleSchema=mongoose.Schema({
    email:{
        type:String
    },
    subject:{
type:String
    },
    industry:{
        type:String
    },
    date:{
        type:Date
    },
    time:{
        type:String
    },
    htmlcontent:{
        type:Buffer
    },
    status:{
        type:String,
        enum:['pending','sent','failed'],
        default:'pending'
    }
})


const scheduleModel=mongoose.model('schedule',scheduleSchema)
module.exports=scheduleModel;