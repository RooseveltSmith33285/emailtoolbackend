const mongoose=require('mongoose')

const contactSchema=mongoose.Schema({
    email:{
        type:String
    },
    industry:{
        type:String
    }
})


const contactmodel=mongoose.model('contact',contactSchema)
module.exports=contactmodel;