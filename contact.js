const mongoose=require('mongoose')

const contactSchema=mongoose.Schema({
    email:{
        type:String
    }
})


const contactmodel=mongoose.model('contact',contactSchema)
module.exports=contactmodel;