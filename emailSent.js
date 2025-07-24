const mongoose=require('mongoose')

const emailSentSchema=mongoose.Schema({
    contact:{
type:mongoose.Schema.ObjectId,
ref:'contact'
    },

},{timestamps:true})

const emailSentModel=mongoose.model('emailSent',emailSentSchema)

module.exports=emailSentModel